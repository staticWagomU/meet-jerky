//! Tauri コマンドの薄いアダプタ層。
//!
//! 実ロジックは `*_inner` 関数に集約してテスト可能にし、
//! `#[tauri::command]` は State / 現在時刻取得などの周辺をまとめるだけの薄いラッパーにする。

use std::path::{Path, PathBuf};

use chrono::FixedOffset;

use crate::session_manager::SessionManager;
use crate::session_store;

// ─────────────────────────────────────────────
// finalize_and_save_session
// ─────────────────────────────────────────────

/// テスト可能な finalize_and_save_session 実装本体。
pub fn finalize_and_save_session_inner(
    manager: &SessionManager,
    output_dir: &Path,
    now_secs: u64,
    offset: FixedOffset,
) -> Result<PathBuf, String> {
    let session = manager.finalize(now_secs).map_err(|e| e.to_string())?;

    // 出力先ディレクトリが無い場合は作成する。
    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("出力ディレクトリの作成に失敗しました: {e}"))?;

    session_store::save_session_markdown(output_dir, &session, offset)
        .map_err(|e| format!("セッションファイルの書き込みに失敗しました: {e}"))
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    // Cycle 1: finalize_and_save_session_inner が活性セッションを書き出せる
    #[test]
    fn finalize_and_save_session_inner_writes_markdown_with_expected_header() {
        let manager = SessionManager::new();
        // 1_713_333_000 UTC = 2024-04-17 14:50 JST
        manager
            .start("会議メモ".into(), 1_713_333_000)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        let dir = tempdir().unwrap();
        let path = finalize_and_save_session_inner(
            &manager,
            dir.path(),
            1_713_333_100,
            jst(),
        )
        .expect("finalize_and_save should succeed");

        assert!(path.exists(), "written file should exist at {:?}", path);
        let contents = std::fs::read_to_string(&path).unwrap();
        let first_line = contents.lines().next().unwrap();
        assert_eq!(first_line, "# 会議メモ - 2024-04-17 14:50");
        assert!(!manager.is_active(), "manager should be cleared after finalize");
    }
}
