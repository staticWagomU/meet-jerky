//! セッションをMarkdownファイルとしてディスクへ保存／一覧するモジュール。
//!
//! Phase 5 TDD: ファイルI/Oはここに閉じ込める。フォーマット処理は `markdown` モジュールに委譲する。
//! リアルタイム追記や Tauri コマンド化は本ループのスコープ外。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::FixedOffset;

use crate::datetime_fmt::{
    format_segment_timestamp_with_offset, format_session_header_timestamp_with_offset,
};
use crate::markdown::{self, SessionMeta};
use crate::session::Session;

/// 完了済みセッションを `<session_id>.md` として `dir` に書き出す。
///
/// 表示用タイムスタンプは `offset` を用いて内部で整形するため、呼び出し側はタイムゾーンだけ渡す。
pub fn save_session_markdown(
    dir: &Path,
    session: &Session,
    offset: FixedOffset,
) -> std::io::Result<PathBuf> {
    let header_display =
        format_session_header_timestamp_with_offset(session.started_at as i64, offset);
    let meta = SessionMeta {
        title: session.title.clone(),
        started_at_display: header_display,
    };

    let segments: Vec<markdown::SessionSegment> = session
        .segments
        .iter()
        .map(|s| markdown::SessionSegment {
            speaker: s.speaker.clone(),
            timestamp_display: format_segment_timestamp_with_offset(
                session.started_at as i64 + s.timestamp_offset_secs as i64,
                offset,
            ),
            text: s.text.clone(),
        })
        .collect();

    let body = markdown::format_session_markdown(&meta, &segments);

    let path = dir.join(format!("{}.md", session.id));
    fs::write(&path, body)?;
    Ok(path)
}

/// 保存済みセッションの一覧用メタデータ。
///
/// ファイル本体を全て読まずに、UI が一覧表示するために必要な情報を提供する。
/// - `started_at_secs` はファイル名先頭（`<started_at>-<seq>.md`）から復元。
/// - `title` はファイル先頭行 `# ...` の `# ` を除いた残り全体（日付を含む）。
///   日付を分離しない方針: 呼び出し側が素のヘッダ文字列をそのまま見せれば十分。
#[derive(Debug, Clone, PartialEq)]
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
        let title = trimmed.strip_prefix("# ").unwrap_or(trimmed).to_string();

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
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
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

        assert_eq!(files.len(), 2, "should list only .md files, got {:?}", files);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"a.md".to_string()));
        assert!(names.contains(&"b.md".to_string()));
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
        fs::write(dir.path().join("100-0.md"), "# 会議メモ - 2024-01-01 00:01\n").unwrap();
        fs::write(dir.path().join("200-0.md"), "# 会議メモ - 2024-01-01 00:02\n").unwrap();
        fs::write(dir.path().join("50-0.md"), "# 会議メモ - 2024-01-01 00:00\n").unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        let secs: Vec<u64> = summaries.iter().map(|s| s.started_at_secs).collect();
        assert_eq!(secs, vec![200, 100, 50]);
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
}
