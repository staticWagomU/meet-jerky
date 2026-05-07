//! 保存済みセッションファイルの列挙に関する tauri コマンドと実装本体。
//!
//! `session_commands.rs` 本来責務 (start / finalize / discard 等のセッション操作) からは
//! 機能境界が独立しているため別 module に分離。`resolve_output_directory` のみ
//! `session_commands` から `pub(crate)` で借用する。

use std::io::ErrorKind;
use std::path::Path;

use crate::session_commands_helpers::resolve_output_directory;
use crate::session_store;
use crate::session_store_types::SessionSummary;
use crate::settings::SettingsStateHandle;

/// テスト可能な list_session_summaries 実装本体。
///
/// 初回起動時などでディレクトリが存在しないケースはエラーにせず空配列を返す。
pub fn list_session_summaries_inner(output_dir: &Path) -> Result<Vec<SessionSummary>, String> {
    if !output_dir.exists() {
        return Ok(Vec::new());
    }
    map_list_session_summaries_result(session_store::list_session_summaries(output_dir))
}

fn map_list_session_summaries_result(
    result: std::io::Result<Vec<SessionSummary>>,
) -> Result<Vec<SessionSummary>, String> {
    match result {
        Ok(summaries) => Ok(summaries),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!("セッション一覧の取得に失敗しました: {err}")),
    }
}

#[tauri::command]
pub fn list_session_summaries_cmd(
    settings_state: tauri::State<'_, SettingsStateHandle>,
) -> Result<Vec<SessionSummary>, String> {
    let output_dir = resolve_output_directory(settings_state.inner());
    list_session_summaries_inner(&output_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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

    // Cycle 5b: output_dir がファイルの場合 list_session_summaries_inner が日本語エラーを返す
    #[test]
    fn list_session_summaries_inner_returns_error_when_path_is_a_file() {
        let dir = tempdir().unwrap();
        let blocking_file = dir.path().join("not_a_dir.txt");
        std::fs::write(&blocking_file, b"hello").unwrap();
        assert!(blocking_file.exists());
        assert!(blocking_file.is_file());

        let err = list_session_summaries_inner(&blocking_file)
            .expect_err("should error when path is a file not a directory");

        assert!(
            err.starts_with("セッション一覧の取得に失敗しました"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn map_list_session_summaries_result_returns_empty_for_not_found() {
        let summaries =
            map_list_session_summaries_result(Err(std::io::Error::from(ErrorKind::NotFound)))
                .expect("not found should not error");

        assert!(summaries.is_empty());
    }

    #[test]
    fn map_list_session_summaries_result_keeps_permission_denied_as_japanese_error() {
        let err = map_list_session_summaries_result(Err(std::io::Error::from(
            ErrorKind::PermissionDenied,
        )))
        .expect_err("permission denied should remain an error");

        assert!(
            err.starts_with("セッション一覧の取得に失敗しました"),
            "unexpected error message: {err}"
        );
    }
}
