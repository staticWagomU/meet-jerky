//! セッションをMarkdownファイルとしてディスクへ保存／一覧するモジュール。
//!
//! Phase 5 TDD: ファイルI/Oはここに閉じ込める。フォーマット処理は `markdown` モジュールに委譲する。
//! リアルタイム追記や Tauri コマンド化は本ループのスコープ外。

use std::fs;
use std::io::{BufRead, BufReader, Error, ErrorKind, Read};
use std::path::{Path, PathBuf};

use chrono::FixedOffset;
use serde::Serialize;

use crate::datetime_fmt::{
    format_segment_timestamp_with_offset, format_session_header_timestamp_with_offset,
};
use crate::markdown::{self, SessionMeta};
use crate::session::Session;

const MAX_SESSION_SEARCH_TEXT_BYTES: u64 = 64 * 1024;
const MAX_JS_DATE_UNIX_SECS: u64 = 8_640_000_000_000;

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

/// セッションを Markdown 文字列に整形する内部ヘルパー。
fn render_session_markdown(session: &Session, offset: FixedOffset) -> std::io::Result<String> {
    let started_at_secs = unix_secs_i64("session started_at", session.started_at)?;
    let header_display =
        format_session_header_timestamp_with_offset(started_at_secs, offset).map_err(io_invalid)?;
    let meta = SessionMeta {
        title: session.title.clone(),
        started_at_display: header_display,
    };

    let segments: Vec<markdown::SessionSegment> = session
        .segments
        .iter()
        .map(|s| {
            let segment_abs_secs = session
                .started_at
                .checked_add(s.timestamp_offset_secs)
                .ok_or_else(|| io_invalid("session segment timestamp overflow"))?;
            let segment_abs_secs = unix_secs_i64("session segment timestamp", segment_abs_secs)?;
            let timestamp_display = format_segment_timestamp_with_offset(segment_abs_secs, offset)
                .map_err(io_invalid)?;

            Ok(markdown::SessionSegment {
                speaker: s.speaker.clone(),
                timestamp_display,
                text: s.text.clone(),
            })
        })
        .collect::<std::io::Result<_>>()?;

    Ok(markdown::format_session_markdown(&meta, &segments))
}

fn unix_secs_i64(label: &str, unix_secs: u64) -> std::io::Result<i64> {
    i64::try_from(unix_secs)
        .map_err(|_| io_invalid(format!("{label} is out of i64 range: {unix_secs}")))
}

fn io_invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidInput, message.into())
}

fn unescape_inline_markdown_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek().copied() {
                Some('\\' | '`' | '*' | '_' | '[' | ']') => {
                    if let Some(escaped) = chars.next() {
                        out.push(escaped);
                    }
                }
                _ => out.push(ch),
            }
        } else {
            out.push(ch);
        }
    }
    out
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

/// 保存済みセッションの一覧用メタデータ。
///
/// ファイル本体を必要以上に読まず、UI が一覧表示・検索するために必要な情報を提供する。
/// - `started_at_secs` はファイル名先頭（`<started_at>-<seq>.md`）から復元。
/// - `title` はファイル先頭行 `# ...` の `# ` を除いた残り全体（日付を含む）。
///   日付を分離しない方針: 呼び出し側が素のヘッダ文字列をそのまま見せれば十分。
/// - `search_text` は本文検索用。表示はせず、巨大ファイルで UI を重くしないため先頭だけ読む。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: PathBuf,
    pub started_at_secs: u64,
    pub title: String,
    pub search_text: String,
}

/// `dir` 配下の `.md` ファイルを走査し、サマリーを新しい順に返す。
///
/// ファイル名プレフィックスが数値として解釈できないものは無視する（エラーにしない）。
pub fn list_session_summaries(dir: &Path) -> std::io::Result<Vec<SessionSummary>> {
    let mut out = Vec::new();
    for path in list_session_files(dir)? {
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(started_at_secs) = parse_session_started_at_secs(stem) else {
            continue;
        };

        let file = fs::File::open(&path)?;
        let mut reader = BufReader::new(file);
        let mut first_line = String::new();
        reader.read_line(&mut first_line)?;
        let trimmed = first_line.trim_end_matches(['\n', '\r']);
        let title = trimmed.strip_prefix("# ").unwrap_or(trimmed);
        let title = if title.trim().is_empty() {
            stem.to_string()
        } else {
            unescape_inline_markdown_text(title)
        };
        let mut search_bytes = Vec::new();
        reader
            .take(MAX_SESSION_SEARCH_TEXT_BYTES)
            .read_to_end(&mut search_bytes)?;
        let search_text = String::from_utf8_lossy(&search_bytes).to_string();

        out.push(SessionSummary {
            path,
            started_at_secs,
            title,
            search_text,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.started_at_secs));
    Ok(out)
}

fn parse_session_started_at_secs(stem: &str) -> Option<u64> {
    let prefix = stem.split('-').next().unwrap_or("");
    let started_at_secs = prefix.parse::<u64>().ok()?;
    if started_at_secs > MAX_JS_DATE_UNIX_SECS {
        return None;
    }
    Some(started_at_secs)
}

/// `dir` 配下の `.md` 拡張子ファイルを一覧する。
///
/// 返却順は安定化のため昇順ソート済み。
pub fn list_session_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Session;
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
    fn list_session_files_returns_only_md_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        fs::write(dir.path().join("b.md"), "b").unwrap();
        fs::write(dir.path().join("note.txt"), "ignore me").unwrap();

        let files = list_session_files(dir.path()).unwrap();

        assert_eq!(files.len(), 2, "should list only .md files, got {files:?}");
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"a.md".to_string()));
        assert!(names.contains(&"b.md".to_string()));
    }

    #[test]
    fn list_session_files_ignores_md_directories() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("100-0.md"), "# 会議メモ\n").unwrap();
        fs::create_dir(dir.path().join("not-a-session.md")).unwrap();

        let files = list_session_files(dir.path()).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_name().unwrap().to_string_lossy(), "100-0.md");
    }

    #[test]
    fn list_session_summaries_returns_single_summary_with_metadata() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("100-0.md"),
            "# 会議メモ - 2024-04-17 14:50\n\n**[14:50:15] 自分:** 検索できる本文  \n",
        )
        .unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].started_at_secs, 100);
        assert_eq!(summaries[0].title, "会議メモ - 2024-04-17 14:50");
        assert!(
            summaries[0].search_text.contains("検索できる本文"),
            "search_text should include transcript body"
        );
        assert_eq!(
            summaries[0].path.file_name().unwrap().to_string_lossy(),
            "100-0.md"
        );
    }

    #[test]
    fn list_session_summaries_limits_search_text_size() {
        let dir = tempdir().unwrap();
        let long_body = "x".repeat(MAX_SESSION_SEARCH_TEXT_BYTES as usize + 1024);
        fs::write(
            dir.path().join("100-0.md"),
            format!("# 会議メモ - 2024-04-17 14:50\n{long_body}"),
        )
        .unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].search_text.len(),
            MAX_SESSION_SEARCH_TEXT_BYTES as usize
        );
    }

    #[test]
    fn list_session_summaries_sorted_newest_first() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("100-0.md"),
            "# 会議メモ - 2024-01-01 00:01\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("200-0.md"),
            "# 会議メモ - 2024-01-01 00:02\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("50-0.md"),
            "# 会議メモ - 2024-01-01 00:00\n",
        )
        .unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        let secs: Vec<u64> = summaries.iter().map(|s| s.started_at_secs).collect();
        assert_eq!(secs, vec![200, 100, 50]);
    }

    #[test]
    fn list_session_summaries_skips_unparsable_prefixes() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("100-0.md"),
            "# 会議メモ - 2024-04-17 14:50\n",
        )
        .unwrap();
        fs::write(dir.path().join("notes.md"), "# メモ - 自由記述\n").unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].started_at_secs, 100);
    }

    #[test]
    fn list_session_summaries_skips_out_of_js_date_range_prefixes() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("100-0.md"),
            "# 会議メモ - 2024-04-17 14:50\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("8640000000001-0.md"),
            "# 壊れた履歴 - 275760-09-13 00:00\n",
        )
        .unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].started_at_secs, 100);
        assert_eq!(summaries[0].title, "会議メモ - 2024-04-17 14:50");
    }

    #[test]
    fn list_session_summaries_uses_file_stem_when_title_is_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("100-0.md"), "# \n").unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "100-0");
    }

    #[test]
    fn list_session_summaries_unescapes_markdown_title_for_display() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("100-0.md"),
            r#"# 会議 \*重要\* \[メモ\] - 2024-04-17 14:50
"#,
        )
        .unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "会議 *重要* [メモ] - 2024-04-17 14:50");
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
    fn list_session_files_returns_err_when_dir_does_not_exist() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("not-exists");

        let err = list_session_files(&missing).unwrap_err();

        assert_eq!(
            err.kind(),
            ErrorKind::NotFound,
            "存在しないディレクトリは NotFound を返す契約: {err}"
        );
    }

    #[test]
    fn list_session_summaries_returns_err_when_dir_does_not_exist() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("not-exists");

        let err = list_session_summaries(&missing).unwrap_err();

        assert_eq!(
            err.kind(),
            ErrorKind::NotFound,
            "存在しないディレクトリは NotFound を返す契約: {err}"
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
    fn unix_secs_i64_returns_value_for_valid_u64_inputs() {
        assert_eq!(unix_secs_i64("test", 0).unwrap(), 0);
        assert_eq!(unix_secs_i64("test", i64::MAX as u64).unwrap(), i64::MAX);
    }

    #[test]
    fn unix_secs_i64_returns_invalid_input_error_for_overflow() {
        use std::io::ErrorKind;
        assert_eq!(
            unix_secs_i64("test", (i64::MAX as u64) + 1)
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            unix_secs_i64("test", u64::MAX).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn unix_secs_i64_error_message_includes_label_and_value_exactly() {
        assert_eq!(
            unix_secs_i64("session started_at", u64::MAX)
                .unwrap_err()
                .to_string(),
            "session started_at is out of i64 range: 18446744073709551615"
        );
    }

    #[test]
    fn io_invalid_always_returns_invalid_input_kind_with_passed_message() {
        use std::io::ErrorKind;
        let e1 = io_invalid("any message");
        assert_eq!(e1.kind(), ErrorKind::InvalidInput);
        assert_eq!(e1.to_string(), "any message");
        let e2 = io_invalid("別のメッセージ");
        assert_eq!(e2.kind(), ErrorKind::InvalidInput);
        assert_eq!(e2.to_string(), "別のメッセージ");
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
}
