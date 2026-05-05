//! セッションをMarkdownファイルとしてディスクへ保存／一覧するモジュール。
//!
//! Phase 5 TDD: ファイルI/Oはここに閉じ込める。フォーマット処理は `markdown` モジュールに委譲する。
//! リアルタイム追記や Tauri コマンド化は本ループのスコープ外。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::FixedOffset;

use crate::session::Session;
use crate::session_store_render::render_session_markdown;

pub use crate::session_store_list::list_session_summaries;

/// セッションを保存するファイルパスを決定する。
///
/// `<dir>/<session_id>.md` となり、`session_id` は `<started_at_secs>-<seq>` 形式。
pub fn path_for_session(dir: &Path, session: &Session) -> PathBuf {
    dir.join(format!("{}.md", session.id))
}

/// 指定パスに現在のセッション内容を Markdown として書き出す（全文上書き）。
///
/// インクリメンタル書き出し（append ごとの rewrite）と finalize 時の最終書き出しの両方から
/// 呼ぶことを想定。
pub fn write_session_markdown_to(
    path: &Path,
    session: &Session,
    offset: FixedOffset,
) -> std::io::Result<()> {
    let body = render_session_markdown(session, offset)?;
    fs::write(path, body)
}

/// 完了済みセッションを `<session_id>.md` として `dir` に書き出す。
///
/// 表示用タイムスタンプは `offset` を用いて内部で整形するため、呼び出し側はタイムゾーンだけ渡す。
pub fn save_session_markdown(
    dir: &Path,
    session: &Session,
    offset: FixedOffset,
) -> std::io::Result<PathBuf> {
    let path = path_for_session(dir, session);
    write_session_markdown_to(&path, session, offset)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    use crate::session::Session;
    use crate::session_store_parse::{
        parse_session_started_at_secs, unescape_inline_markdown_text,
    };
    use crate::session_store_types::SessionSummary;
    use tempfile::tempdir;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    #[test]
    fn save_session_markdown_writes_file_with_expected_header() {
        // 1_713_333_000 UTC = 2024-04-17 14:50 JST
        let session = Session::start("会議メモ".to_string(), 1_713_333_000);
        let dir = tempdir().unwrap();

        let path = save_session_markdown(dir.path(), &session, jst()).unwrap();

        assert!(path.exists(), "written file should exist");
        let contents = fs::read_to_string(&path).unwrap();
        let first_line = contents.lines().next().unwrap();
        assert_eq!(first_line, "# 会議メモ - 2024-04-17 14:50");
    }

    #[test]
    fn save_session_markdown_writes_segment_line() {
        // started_at = 1_713_333_000 UTC = 14:50:00 JST, offset 15s -> 14:50:15
        let mut session = Session::start("会議メモ".to_string(), 1_713_333_000);
        session.append_segment("自分".into(), 15, "hello".into());
        let dir = tempdir().unwrap();

        let path = save_session_markdown(dir.path(), &session, jst()).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        assert!(
            contents.contains("**[14:50:15] 自分:** hello"),
            "segment line missing. contents=\n{contents}"
        );
    }

    #[test]
    fn save_session_markdown_writes_distinct_segment_timestamps_and_hard_breaks() {
        let mut session = Session::start("会議メモ".to_string(), 1_713_333_000);
        session.append_segment("自分".into(), 15, "hello".into());
        session.append_segment("相手側".into(), 75, "world".into());
        let dir = tempdir().unwrap();

        let path = save_session_markdown(dir.path(), &session, jst()).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        assert!(
            contents.contains("**[14:50:15] 自分:** hello  "),
            "first segment line missing hard break. contents=\n{contents}"
        );
        assert!(
            contents.contains("**[14:51:15] 相手側:** world  "),
            "second segment line missing distinct timestamp or hard break. contents=\n{contents}"
        );
    }

    #[test]
    fn save_session_markdown_returns_error_for_out_of_range_started_at() {
        let session = Session::start("会議メモ".to_string(), i64::MAX as u64);
        let dir = tempdir().unwrap();

        let err = save_session_markdown(dir.path(), &session, jst()).unwrap_err();

        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("out of range"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn save_session_markdown_returns_error_for_overflowing_segment_timestamp() {
        let mut session = Session::start("会議メモ".to_string(), 1_713_333_000);
        session.append_segment("自分".into(), u64::MAX, "hello".into());
        let dir = tempdir().unwrap();

        let err = save_session_markdown(dir.path(), &session, jst()).unwrap_err();

        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("overflow"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn save_session_markdown_returns_err_when_dir_does_not_exist() {
        let tmp = tempdir().unwrap();
        let missing_dir = tmp.path().join("not-exists");
        let mut session = Session::start("test".to_string(), 1700000000);
        session.finalize(1700000060);

        let err = save_session_markdown(&missing_dir, &session, jst()).unwrap_err();

        assert_eq!(
            err.kind(),
            ErrorKind::NotFound,
            "存在しないディレクトリは NotFound を返す契約: {err}"
        );
    }

    #[test]
    fn parse_session_started_at_secs_returns_none_for_empty_string() {
        assert_eq!(parse_session_started_at_secs(""), None);
    }

    #[test]
    fn parse_session_started_at_secs_accepts_pure_numeric_without_hyphen() {
        assert_eq!(
            parse_session_started_at_secs("1234567890"),
            Some(1234567890)
        );
    }

    #[test]
    fn parse_session_started_at_secs_accepts_numeric_with_suffix_after_hyphen() {
        assert_eq!(
            parse_session_started_at_secs("1234567890-meet-abc"),
            Some(1234567890)
        );
    }

    #[test]
    fn parse_session_started_at_secs_returns_none_for_leading_hyphen() {
        assert_eq!(parse_session_started_at_secs("-1234567890"), None);
    }

    #[test]
    fn parse_session_started_at_secs_returns_none_for_overflow_u64() {
        assert_eq!(
            parse_session_started_at_secs("99999999999999999999999"),
            None
        );
    }

    #[test]
    fn parse_session_started_at_secs_returns_none_for_negative_sign_prefix() {
        assert_eq!(parse_session_started_at_secs("-12345"), None);
    }

    #[test]
    fn parse_session_started_at_secs_accepts_boundary_max() {
        // MAX_JS_DATE_UNIX_SECS = 8_640_000_000_000; the check is `>`, so == is accepted
        assert_eq!(
            parse_session_started_at_secs("8640000000000"),
            Some(8_640_000_000_000)
        );
    }

    #[test]
    fn parse_session_started_at_secs_returns_none_just_above_boundary() {
        // MAX_JS_DATE_UNIX_SECS + 1 = 8_640_000_000_001 is strictly > MAX, so None
        assert_eq!(parse_session_started_at_secs("8640000000001"), None);
    }

    #[test]
    fn unescape_inline_markdown_text_unescapes_six_target_chars_and_passes_others() {
        for (input, expected) in [
            (r"\\", "\\"),
            (r"\`", "`"),
            (r"\*", "*"),
            (r"\_", "_"),
            (r"\[", "["),
            (r"\]", "]"),
        ] {
            assert_eq!(
                unescape_inline_markdown_text(input),
                expected,
                "input={input:?}"
            );
        }
        assert_eq!(unescape_inline_markdown_text(r"\!"), r"\!");
        assert_eq!(unescape_inline_markdown_text(r"\X"), r"\X");
        assert_eq!(unescape_inline_markdown_text(r"\"), r"\");
    }

    #[test]
    fn unescape_inline_markdown_text_handles_consecutive_backslash_escapes_independently() {
        for (input, expected) in [
            (r"\\\\", r"\\"),
            (r"\\\\\\", r"\\\"),
            (r"\\\\\\\\", r"\\\\"),
        ] {
            assert_eq!(
                unescape_inline_markdown_text(input),
                expected,
                "input={input:?} で連続 backslash の独立 unescape"
            );
        }
    }

    #[test]
    fn unescape_inline_markdown_text_handles_adjacent_six_target_escapes_independently() {
        assert_eq!(
            unescape_inline_markdown_text(r"\*\_"),
            "*_",
            "2 個隣接 escape → 2 chars"
        );
        assert_eq!(
            unescape_inline_markdown_text(r#"\[\]\`"#),
            "[]`",
            "3 個隣接 escape → 3 chars"
        );
        assert_eq!(
            unescape_inline_markdown_text(r#"\*\_\`\[\]\\"#),
            "*_`[]\\",
            "6 文字全種隣接 escape → 各独立 unescape"
        );
    }

    #[test]
    fn unescape_inline_markdown_text_passes_non_target_backslash_through_while_unescaping_target() {
        for (input, expected) in [
            (r"\X\*", r"\X*"),
            (r"abc\*def\_ghi", "abc*def_ghi"),
            (r"\!\*\$", r"\!*\$"),
            (r"\1\*\2", r"\1*\2"),
        ] {
            assert_eq!(
                unescape_inline_markdown_text(input),
                expected,
                "input={input:?} で非対象 backslash passthrough・対象のみ unescape"
            );
        }
    }

    #[test]
    fn unescape_inline_markdown_text_handles_multibyte_chars_adjacent_to_escapes() {
        for (input, expected) in [
            (r"あ\*", "あ*"),
            (r"\*あ", "*あ"),
            (r"\*あ\_い", "*あ_い"),
            (r"\*🎉\_", "*🎉_"),
            (r"\🎉", r"\🎉"),
        ] {
            assert_eq!(
                unescape_inline_markdown_text(input),
                expected,
                "input={input:?} で multibyte 隣接 escape の独立 unescape"
            );
        }
    }

    #[test]
    fn unescape_after_explicit_six_char_escape_recovers_original_text_for_no_whitespace_inputs() {
        let explicit_escape = |s: &str| -> String {
            let mut out = String::new();
            for ch in s.chars() {
                if matches!(ch, '\\' | '`' | '*' | '_' | '[' | ']') {
                    out.push('\\');
                }
                out.push(ch);
            }
            out
        };
        for original in ["hello", r"a*b_c", r"\backslash", r#"[`*_\\]"#, "あいう★"] {
            assert_eq!(
                unescape_inline_markdown_text(&explicit_escape(original)),
                original,
                "input={original:?} で explicit_escape → unescape round-trip が original を復元"
            );
        }
    }

    #[test]
    fn path_for_session_joins_dir_and_session_id_with_md_extension() {
        let dir = PathBuf::from("/tmp/meet-jerky-test");
        let session = Session::start("title".into(), 1_700_000_000);
        let path = path_for_session(&dir, &session);

        assert_eq!(
            path.parent(),
            Some(dir.as_path()),
            "親ディレクトリが dir と一致する契約"
        );
        assert_eq!(
            path.extension().and_then(|s| s.to_str()),
            Some("md"),
            ".md 拡張子である契約"
        );
        assert_eq!(
            path.file_stem().and_then(|s| s.to_str()),
            Some(session.id.as_str()),
            "file_stem が session.id と一致する契約"
        );
    }

    #[test]
    fn path_for_session_file_name_is_exactly_session_id_dot_md() {
        let dir = PathBuf::from("/some/dir");
        let session = Session::start("title".into(), 1_700_000_000);
        let path = path_for_session(&dir, &session);
        let expected_file_name = format!("{}.md", session.id);

        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some(expected_file_name.as_str()),
            "file_name が '<id>.md' ちょうどである契約: 接尾辞・接頭辞が混入しない"
        );
    }

    #[test]
    fn path_for_session_preserves_relative_dir_passthrough() {
        let dir = PathBuf::from("relative/sub/dir");
        let session = Session::start("title".into(), 1_700_000_000);
        let path = path_for_session(&dir, &session);
        let expected_file_name = format!("{}.md", session.id);

        assert!(
            path.starts_with("relative/sub/dir"),
            "relative dir がそのまま親に使われる契約"
        );
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some(expected_file_name.as_str()),
            "file_name が '<id>.md' である契約"
        );
        assert!(
            !path.is_absolute(),
            "relative passthrough、absolute 化しない契約"
        );
    }

    #[test]
    fn path_for_session_returns_bare_file_name_when_dir_is_empty() {
        let dir = PathBuf::new();
        let session = Session::start("title".into(), 1_700_000_000);
        let path = path_for_session(&dir, &session);
        let expected = format!("{}.md", session.id);

        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some(expected.as_str()),
            "空 dir でも '<id>.md' 単体の相対 path が返る契約"
        );
        assert!(
            path.parent()
                .map(|p| p.as_os_str().is_empty())
                .unwrap_or(true),
            "parent が空または None である契約"
        );
        assert!(
            !path.is_absolute(),
            "empty dir join は absolute 化しない契約"
        );
    }

    #[test]
    fn path_for_session_uses_session_id_passthrough_for_zero_and_max_started_at() {
        let s_zero = Session::start("anything".into(), 0);
        let p_zero = path_for_session(&PathBuf::from("/d"), &s_zero);
        assert_eq!(
            p_zero.file_stem().and_then(|s| s.to_str()),
            Some(s_zero.id.as_str()),
            "started_at=0 の session.id が file_stem に passthrough される契約"
        );
        assert!(
            p_zero
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap()
                .starts_with("0-"),
            "id が '0-' prefix を持つ契約"
        );

        let s_max = Session::start("特殊文字 / \\ : *".into(), u64::MAX);
        let p_max = path_for_session(&PathBuf::from("/d"), &s_max);
        assert_eq!(
            p_max.file_stem().and_then(|s| s.to_str()),
            Some(s_max.id.as_str()),
            "started_at=u64::MAX の session.id が file_stem に passthrough される契約"
        );
        let max_prefix = format!("{}-", u64::MAX);
        assert!(
            p_max
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap()
                .starts_with(&max_prefix),
            "id が u64::MAX のプレフィックスを持つ契約"
        );
        assert!(
            !p_max.to_string_lossy().contains("特殊文字"),
            "title が path に漏れない契約"
        );
        assert!(
            !p_max.to_string_lossy().contains("*"),
            "title 内 special char が path に漏れない契約"
        );
    }

    #[test]
    fn write_session_markdown_to_writes_same_content_as_save_session_markdown_for_explicit_path() {
        // T1: write_session_markdown_to の direct 呼び出し結果が save_session_markdown と内容一致
        let mut session = Session::start("会議メモ".to_string(), 1_713_333_000);
        session.append_segment("自分".into(), 15, "hello".into());
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();

        let direct_path = dir1.path().join("explicit_name.md");
        write_session_markdown_to(&direct_path, &session, jst()).unwrap();

        let composed_path = save_session_markdown(dir2.path(), &session, jst()).unwrap();

        let direct_content = fs::read_to_string(&direct_path).unwrap();
        let composed_content = fs::read_to_string(&composed_path).unwrap();
        assert_eq!(
            direct_content, composed_content,
            "write_session_markdown_to と save_session_markdown は path 以外で内容差分なしの契約 = 構成要素 2 つの分離"
        );
    }

    #[test]
    fn write_session_markdown_to_truncates_and_overwrites_existing_file_completely() {
        // T2: 既存ファイルの完全上書き (truncate) 契約 = fs::write の truncate 挙動 = OpenOptions::append への誤改修検知装置
        let session = Session::start("新内容".to_string(), 1_713_333_000);
        let dir = tempdir().unwrap();
        let path = dir.path().join("target.md");

        let pre_existing = "# 旧内容ヘッダ\n\n".to_string() + &"x".repeat(10_000);
        fs::write(&path, &pre_existing).unwrap();
        assert!(
            fs::read_to_string(&path).unwrap().len() > 10_000,
            "前提: 既存ファイルが長い"
        );

        write_session_markdown_to(&path, &session, jst()).unwrap();

        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.starts_with("# 新内容 - "),
            "新内容で完全上書きされる契約: {}",
            &after[..40.min(after.len())]
        );
        assert!(
            !after.contains("旧内容ヘッダ"),
            "旧内容が残らない契約 = fs::write の truncate 挙動 = OpenOptions::append への誤改修検知装置"
        );
        assert!(
            !after.contains("xxxxxxxxxx"),
            "旧 body の長い x 列が残らない契約"
        );
    }

    #[test]
    fn write_session_markdown_to_returns_not_found_when_parent_dir_missing() {
        // T3: 親ディレクトリ無しで NotFound を返す path 単独契約
        let tmp = tempdir().unwrap();
        let missing_dir_path = tmp.path().join("does-not-exist").join("file.md");
        let session = Session::start("test".to_string(), 1_700_000_000);

        let err = write_session_markdown_to(&missing_dir_path, &session, jst()).unwrap_err();

        assert_eq!(
            err.kind(),
            ErrorKind::NotFound,
            "親ディレクトリ無し path 単独で NotFound 契約: {err}"
        );
        assert!(!missing_dir_path.exists(), "ファイルが作成されていないこと");
    }

    #[test]
    fn write_session_markdown_to_propagates_render_error_for_out_of_range_started_at_without_creating_file(
    ) {
        // T4: render エラーが ? で素通り伝播し、書き出し前 error なのでファイル未作成
        let session = Session::start("会議メモ".to_string(), i64::MAX as u64 + 1);
        let dir = tempdir().unwrap();
        let path = dir.path().join("should_not_exist.md");

        let err = write_session_markdown_to(&path, &session, jst()).unwrap_err();

        assert_eq!(
            err.kind(),
            ErrorKind::InvalidInput,
            "render エラーの ErrorKind が write 側まで ? で素通り伝播する契約"
        );
        assert!(
            err.to_string().contains("out of i64 range"),
            "error message も握り潰されず伝播する契約: {err}"
        );
        assert!(
            !path.exists(),
            "render error は書き出し前なのでファイル未作成 = ? が握り潰されず render を先に評価する契約"
        );
    }

    #[test]
    fn write_session_markdown_to_propagates_segment_overflow_error_without_creating_file() {
        // T5: segment timestamp overflow → render error → write 側まで ? で素通り伝播 (T4 と対をなす別経路)
        let mut session = Session::start("会議メモ".to_string(), 1_713_333_000);
        session.append_segment("自分".into(), u64::MAX, "hello".into());
        let dir = tempdir().unwrap();
        let path = dir.path().join("should_not_exist_either.md");

        let err = write_session_markdown_to(&path, &session, jst()).unwrap_err();

        assert_eq!(
            err.kind(),
            ErrorKind::InvalidInput,
            "segment overflow の ErrorKind が write 側まで ? で素通り伝播する契約"
        );
        assert!(
            err.to_string().contains("overflow"),
            "error message も握り潰されず伝播する契約: {err}"
        );
        assert!(
            !path.exists(),
            "render error は書き出し前なのでファイル未作成 = T4 と同じ ? 早期 return 契約の別経路確認"
        );
    }

    #[test]
    fn session_summary_debug_output_contains_struct_name_and_all_four_field_names() {
        let summary = SessionSummary {
            path: PathBuf::from("/tmp/sessions/1234-0.md"),
            started_at_secs: 1_234_567_890,
            title: "Daily Standup".to_string(),
            search_text: "hello world".to_string(),
        };
        let output = format!("{:?}", summary);
        assert!(
            output.contains("SessionSummary"),
            "型名 'SessionSummary' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("path"),
            "field 名 'path' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("started_at_secs"),
            "field 名 'started_at_secs' (snake_case) が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("title"),
            "field 名 'title' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("search_text"),
            "field 名 'search_text' (snake_case) が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("1234567890"),
            "値 '1234567890' (started_at_secs) が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("Daily Standup"),
            "値 'Daily Standup' (title) が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("hello world"),
            "値 'hello world' (search_text) が Debug 出力に含まれる契約: got {}",
            output
        );
    }

    #[test]
    fn session_summary_partial_eq_holds_reflexive_and_differs_for_each_field() {
        let base = SessionSummary {
            path: PathBuf::from("/a"),
            started_at_secs: 100,
            title: "t".to_string(),
            search_text: "s".to_string(),
        };
        let same = SessionSummary {
            path: PathBuf::from("/a"),
            started_at_secs: 100,
            title: "t".to_string(),
            search_text: "s".to_string(),
        };
        let path_diff = SessionSummary {
            path: PathBuf::from("/b"),
            ..base.clone()
        };
        let started_diff = SessionSummary {
            started_at_secs: 200,
            ..base.clone()
        };
        let title_diff = SessionSummary {
            title: "u".to_string(),
            ..base.clone()
        };
        let search_diff = SessionSummary {
            search_text: "x".to_string(),
            ..base.clone()
        };
        assert_eq!(base, same, "PartialEq reflexive: 同 4 field 値で等値");
        assert_ne!(base, path_diff, "PartialEq: path のみ違うと不等値");
        assert_ne!(
            base, started_diff,
            "PartialEq: started_at_secs のみ違うと不等値"
        );
        assert_ne!(base, title_diff, "PartialEq: title のみ違うと不等値");
        assert_ne!(base, search_diff, "PartialEq: search_text のみ違うと不等値");
    }

    #[test]
    fn session_summary_serde_serialize_uses_camel_case_for_all_four_fields() {
        let summary = SessionSummary {
            path: PathBuf::from("/tmp/x.md"),
            started_at_secs: 42,
            title: "T".to_string(),
            search_text: "S".to_string(),
        };
        let value = serde_json::to_value(&summary).unwrap();
        let obj = value
            .as_object()
            .expect("SessionSummary should serialize as JSON object");
        assert!(
            obj.contains_key("path"),
            "key 'path' が JSON に含まれる契約: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            obj.contains_key("startedAtSecs"),
            "key 'startedAtSecs' (camelCase) が JSON に含まれる契約: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            obj.contains_key("title"),
            "key 'title' が JSON に含まれる契約: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            obj.contains_key("searchText"),
            "key 'searchText' (camelCase) が JSON に含まれる契約: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            obj.len(),
            4,
            "SessionSummary の JSON object は 4 key 厳密: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            !obj.contains_key("started_at_secs"),
            "snake_case key 'started_at_secs' が JSON に含まれない契約: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            !obj.contains_key("search_text"),
            "snake_case key 'search_text' が JSON に含まれない契約: got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            obj.get("startedAtSecs").and_then(|v| v.as_u64()),
            Some(42),
            "startedAtSecs 値が JSON に正しく載る契約"
        );
        assert_eq!(
            obj.get("title").and_then(|v| v.as_str()),
            Some("T"),
            "title 値が JSON に正しく載る契約"
        );
        assert_eq!(
            obj.get("searchText").and_then(|v| v.as_str()),
            Some("S"),
            "searchText 値が JSON に正しく載る契約"
        );
    }
}
