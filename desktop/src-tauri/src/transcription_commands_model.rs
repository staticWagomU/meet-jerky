//! Whisper モデルの一覧取得 / ダウンロード判定 / ダウンロード実行に関する tauri コマンド群と
//! `model-download-progress` / `model-download-error` イベントの payload 純粋関数。
//!
//! `transcription_commands.rs` 本来責務 (start/stop transcription) からモデル管理軸を切り出して
//! 機能境界で分離する。

use tauri::Emitter;

use crate::transcription_model_manager::ModelManager;
use crate::transcription_types::ModelInfo;

pub(crate) const MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "model-download-progress";
pub(crate) const MODEL_DOWNLOAD_ERROR_EVENT: &str = "model-download-error";

/// 利用可能なモデル一覧を返す
#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    ModelManager::list_available_models()
}

/// モデルがダウンロード済みかを確認する
#[tauri::command]
pub fn is_model_downloaded(model_name: String) -> bool {
    let manager = ModelManager::new();
    manager.is_model_downloaded(&model_name)
}

/// `model-download-progress` イベントの payload を組み立てる（純粋関数）
pub(crate) fn build_download_progress_payload(progress: f64, model: &str) -> serde_json::Value {
    serde_json::json!({ "progress": progress, "model": model })
}

/// `model-download-error` イベントの payload を組み立てる（純粋関数）
pub(crate) fn build_download_error_payload(model: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "model": model, "message": message })
}

/// モデルをダウンロードする（プログレスイベントを送信）
///
/// 失敗時は Result で Err を返すことに加え、`model-download-error` を emit する。
/// 既存の `invoke` catch 経路に加えて listen 側でも統一的にハンドリングできるようにする。
#[tauri::command]
pub async fn download_model(model_name: String, app: tauri::AppHandle) -> Result<String, String> {
    let model_name_for_progress = model_name.clone();
    let app_for_progress = app.clone();

    // ダウンロードはブロッキングI/Oなので専用スレッドで実行
    let join_result = tokio::task::spawn_blocking(move || {
        let manager = ModelManager::new();
        let model_name_ref = model_name_for_progress.clone();
        manager.download_model(&model_name_for_progress, move |progress| {
            let _ = app_for_progress.emit(
                MODEL_DOWNLOAD_PROGRESS_EVENT,
                build_download_progress_payload(progress, &model_name_ref),
            );
        })
    })
    .await
    .map_err(|e| format!("ダウンロードタスクの実行に失敗しました: {e}"));

    match join_result {
        Ok(Ok(path)) => Ok(path.to_string_lossy().to_string()),
        Ok(Err(msg)) => {
            let _ = app.emit(
                MODEL_DOWNLOAD_ERROR_EVENT,
                build_download_error_payload(&model_name, &msg),
            );
            Err(msg)
        }
        Err(msg) => {
            let _ = app.emit(
                MODEL_DOWNLOAD_ERROR_EVENT,
                build_download_error_payload(&model_name, &msg),
            );
            Err(msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_download_event_names_are_stable() {
        assert_eq!(MODEL_DOWNLOAD_PROGRESS_EVENT, "model-download-progress");
        assert_eq!(MODEL_DOWNLOAD_ERROR_EVENT, "model-download-error");
    }

    #[test]
    fn test_download_progress_payload_serialization() {
        // 既存 progress イベントの payload 形を固定化（回帰防止）。
        // 型側 DownloadProgressPayload { progress, model } と噛み合う形を保証する。
        let payload = build_download_progress_payload(0.5, "small");
        let s = payload.to_string();
        assert!(s.contains("\"progress\":0.5"), "got: {s}");
        assert!(s.contains("\"model\":\"small\""), "got: {s}");
    }

    #[test]
    fn test_download_error_payload_serialization() {
        // model-download-error の payload は { model, message } のフラットキー。
        // TypeScript 側 DownloadErrorPayload と噛み合う形を保証する。
        let payload = build_download_error_payload("small", "HTTP 404");
        let s = payload.to_string();
        assert!(s.contains("\"model\":\"small\""), "got: {s}");
        assert!(s.contains("\"message\":\"HTTP 404\""), "got: {s}");
    }
}
