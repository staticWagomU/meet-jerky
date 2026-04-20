//! Tauri コマンドの薄いアダプタ層。
//!
//! 実ロジックは `*_inner` 関数に集約してテスト可能にし、
//! `#[tauri::command]` は State / 現在時刻取得などの周辺をまとめるだけの薄いラッパーにする。

use std::path::{Path, PathBuf};

use chrono::FixedOffset;

use crate::session_manager::SessionManager;
use crate::session_store::{self, SessionSummary};

// ─────────────────────────────────────────────
// start_session
// ─────────────────────────────────────────────

/// テスト可能な start_session 実装本体。
pub fn start_session_inner(
    manager: &SessionManager,
    title: String,
    started_at: u64,
) -> Result<(), String> {
    manager.start(title, started_at).map_err(|e| e.to_string())
}

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
// list_session_summaries
// ─────────────────────────────────────────────

/// テスト可能な list_session_summaries 実装本体。
///
/// 初回起動時などでディレクトリが存在しないケースはエラーにせず空配列を返す。
pub fn list_session_summaries_inner(output_dir: &Path) -> Result<Vec<SessionSummary>, String> {
    if !output_dir.exists() {
        return Ok(Vec::new());
    }
    session_store::list_session_summaries(output_dir)
        .map_err(|e| format!("セッション一覧の取得に失敗しました: {e}"))
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

    // Cycle 2: アイドル状態での finalize はエラー文字列を返す
    #[test]
    fn finalize_and_save_session_inner_returns_error_when_idle() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();

        let err = finalize_and_save_session_inner(
            &manager,
            dir.path(),
            1_713_333_100,
            jst(),
        )
        .expect_err("idle manager should error");

        assert_eq!(err, "no active session");
    }

    // Cycle 3a: start_session_inner でアイドルマネージャが活性化される
    #[test]
    fn start_session_inner_activates_idle_manager() {
        let manager = SessionManager::new();
        assert!(!manager.is_active());

        start_session_inner(&manager, "会議".into(), 100).expect("start should succeed");

        assert!(manager.is_active());
        assert_eq!(manager.current_title(), Some("会議".into()));
    }

    // Cycle 3b: 既に活性なら "session already active" エラー
    #[test]
    fn start_session_inner_errors_when_already_active() {
        let manager = SessionManager::new();
        start_session_inner(&manager, "first".into(), 100).expect("first start");

        let err = start_session_inner(&manager, "second".into(), 200)
            .expect_err("second start should error");

        assert_eq!(err, "session already active");
        assert_eq!(manager.current_title(), Some("first".into()));
    }

    // Cycle 4: list_session_summaries_inner が保存済みファイルを返す (スモーク)
    #[test]
    fn list_session_summaries_inner_returns_saved_summary() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("100-0.md"),
            "# 会議メモ - 2024-04-17 14:50\n",
        )
        .unwrap();

        let summaries = list_session_summaries_inner(dir.path()).expect("listing should succeed");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].started_at_secs, 100);
        assert_eq!(summaries[0].title, "会議メモ - 2024-04-17 14:50");
    }

    // 存在しないディレクトリは空配列を返す (初回起動時の UX)
    #[test]
    fn list_session_summaries_inner_returns_empty_for_missing_dir() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does_not_exist");

        let summaries =
            list_session_summaries_inner(&missing).expect("missing dir should not error");

        assert!(summaries.is_empty());
    }
}
