use crate::transcription_model_manager::ModelManager;
use crate::transcription_types::ModelInfo;

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

#[cfg(test)]
mod tests {
    use super::*;

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
