//! セッションをMarkdownファイルとしてディスクへ保存／一覧するモジュール。
//!
//! Phase 5 TDD: ファイルI/Oはここに閉じ込める。フォーマット処理は `markdown` モジュールに委譲する。
//! リアルタイム追記や Tauri コマンド化は本ループのスコープ外。

use std::fs;
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
}
