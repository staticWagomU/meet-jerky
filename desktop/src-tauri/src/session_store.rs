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

        assert_eq!(
            files.len(),
            2,
            "should list only .md files, got {:?}",
            files
        );
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
            "segment line missing. contents=\n{}",
            contents
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
            "first segment line missing hard break. contents=\n{}",
            contents
        );
        assert!(
            contents.contains("**[14:51:15] 相手側:** world  "),
            "second segment line missing distinct timestamp or hard break. contents=\n{}",
            contents
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

        let result = list_session_files(&missing);

        assert!(result.is_err(), "should fail when dir does not exist");
    }

    #[test]
    fn list_session_summaries_returns_err_when_dir_does_not_exist() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("not-exists");

        let result = list_session_summaries(&missing);

        assert!(result.is_err(), "should fail when dir does not exist");
    }

    #[test]
    fn save_session_markdown_returns_err_when_dir_does_not_exist() {
        let tmp = tempdir().unwrap();
        let missing_dir = tmp.path().join("not-exists");
        let mut session = Session::start("test".to_string(), 1700000000);
        session.finalize(1700000060);

        let result = save_session_markdown(&missing_dir, &session, jst());

        assert!(result.is_err(), "should fail when dir does not exist");
    }
}
