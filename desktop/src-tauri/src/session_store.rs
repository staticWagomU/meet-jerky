//! セッションをMarkdownファイルとしてディスクへ保存／一覧するモジュール。
//!
//! Phase 5 TDD: ファイルI/Oはここに閉じ込める。フォーマット処理は `markdown` モジュールに委譲する。
//! リアルタイム追記や Tauri コマンド化は本ループのスコープ外。

use std::fs;
use std::io::{BufRead, BufReader, Error, ErrorKind};
use std::path::{Path, PathBuf};

use chrono::FixedOffset;
use serde::Serialize;

use crate::datetime_fmt::{
    format_segment_timestamp_with_offset, format_session_header_timestamp_with_offset,
};
use crate::markdown::{self, SessionMeta};
use crate::session::Session;

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
/// ファイル本体を全て読まずに、UI が一覧表示するために必要な情報を提供する。
/// - `started_at_secs` はファイル名先頭（`<started_at>-<seq>.md`）から復元。
/// - `title` はファイル先頭行 `# ...` の `# ` を除いた残り全体（日付を含む）。
///   日付を分離しない方針: 呼び出し側が素のヘッダ文字列をそのまま見せれば十分。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: PathBuf,
    pub started_at_secs: u64,
    pub title: String,
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
        let prefix = stem.split('-').next().unwrap_or("");
        let Ok(started_at_secs) = prefix.parse::<u64>() else {
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
            title.to_string()
        };

        out.push(SessionSummary {
            path,
            started_at_secs,
            title,
        });
    }
    out.sort_by(|a, b| b.started_at_secs.cmp(&a.started_at_secs));
    Ok(out)
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
            "# 会議メモ - 2024-04-17 14:50\n",
        )
        .unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].started_at_secs, 100);
        assert_eq!(summaries[0].title, "会議メモ - 2024-04-17 14:50");
        assert_eq!(
            summaries[0].path.file_name().unwrap().to_string_lossy(),
            "100-0.md"
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
    fn list_session_summaries_uses_file_stem_when_title_is_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("100-0.md"), "# \n").unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "100-0");
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
}
