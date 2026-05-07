//! セッション一覧 (list) 専門 module。
//!
//! ディスク I/O を伴うが、書き出し系 (write/save) は session_store.rs、
//! 一覧系 (list) は本 module に分離。

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use crate::session_store_parse::{parse_session_started_at_secs, unescape_inline_markdown_text};
use crate::session_store_types::SessionSummary;

const MAX_SESSION_SEARCH_TEXT_BYTES: u64 = 64 * 1024;

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
        let mut first_line = Vec::new();
        reader.read_until(b'\n', &mut first_line)?;
        if first_line.last() == Some(&b'\n') {
            first_line.pop();
        }
        if first_line.last() == Some(&b'\r') {
            first_line.pop();
        }
        let first_line = String::from_utf8_lossy(&first_line);
        let title = first_line.strip_prefix("# ").unwrap_or(&first_line);
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
    use std::fs;
    use std::io::ErrorKind;

    use tempfile::tempdir;

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
    fn list_session_summaries_uses_lossy_utf8_for_invalid_title_line() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("100-0.md"),
            [
                b"# Invalid ".as_slice(),
                &[0xff, 0xfe],
                b" title\r\nbody remains searchable".as_slice(),
            ]
            .concat(),
        )
        .unwrap();
        fs::write(dir.path().join("200-0.md"), "# Valid title\nvalid body").unwrap();

        let summaries = list_session_summaries(dir.path()).unwrap();

        assert_eq!(summaries.len(), 2);
        let invalid = summaries
            .iter()
            .find(|summary| summary.started_at_secs == 100)
            .unwrap();
        assert_eq!(invalid.title, "Invalid \u{fffd}\u{fffd} title");
        assert!(
            invalid.search_text.contains("body remains searchable"),
            "search_text should still start after the lossy title line"
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
}
