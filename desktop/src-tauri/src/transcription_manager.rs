use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::transcription_model_manager::ModelManager;
use crate::transcription_traits::TranscriptionEngine;
use crate::transcription_whisper_local::WhisperLocal;

pub struct TranscriptionManager {
    pub(crate) engine: Option<Arc<dyn TranscriptionEngine>>,
    /// 現在ロード中のエンジン種別と、Whisper の場合のモデル名。
    /// 同じ条件での再 ensure_engine 呼び出しでは再初期化をスキップする。
    loaded_engine_signature: Option<(crate::settings::TranscriptionEngineType, String)>,
    running: Arc<AtomicBool>,
    model_manager: ModelManager,
}

impl TranscriptionManager {
    pub fn new() -> Self {
        Self {
            engine: None,
            loaded_engine_signature: None,
            running: Arc::new(AtomicBool::new(false)),
            model_manager: ModelManager::new(),
        }
    }

    /// エンジンが読み込まれているか (テスト用 / 内部診断用)
    #[cfg(test)]
    pub fn is_engine_loaded(&self) -> bool {
        self.engine.is_some()
    }

    /// 文字起こしが実行中か
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Whisper モデルを読み込む（まだ読み込まれていない場合）
    pub fn load_model(&mut self, model_name: &str) -> Result<(), String> {
        let model_path = self.model_manager.get_model_path(model_name);
        if !model_path.exists() {
            return Err(format!("モデルがダウンロードされていません: {model_name}"));
        }

        let path_str = model_path
            .to_str()
            .ok_or_else(|| "モデルパスの変換に失敗しました".to_string())?;
        let engine = WhisperLocal::new(path_str)?;
        self.engine = Some(Arc::new(engine));
        Ok(())
    }

    /// 設定で選択されたエンジンに切り替える。
    ///
    /// 同じエンジン種別 (Whisper の場合は同じモデル名) が既に読み込まれていれば
    /// 何もしない。条件が変わった場合は古いエンジンを破棄して新しいエンジンを
    /// 初期化する。
    ///
    /// `whisper_model` は Whisper を選んだ時のみ参照される。
    pub fn ensure_engine(
        &mut self,
        engine_type: &crate::settings::TranscriptionEngineType,
        whisper_model: &str,
    ) -> Result<(), String> {
        use crate::settings::TranscriptionEngineType;

        // 既にロード済みなら早期 return。Whisper は model 名一致が条件、
        // それ以外は engine 種別一致のみで判定。
        let signature = (engine_type.clone(), whisper_model.to_string());
        if self.engine.is_some() && self.loaded_engine_signature.as_ref() == Some(&signature) {
            return Ok(());
        }

        match engine_type {
            TranscriptionEngineType::Whisper => {
                self.load_model(whisper_model)?;
            }
            TranscriptionEngineType::AppleSpeech => {
                let engine = crate::apple_speech::AppleSpeechEngine::new()?;
                self.engine = Some(Arc::new(engine));
            }
            TranscriptionEngineType::OpenAIRealtime => {
                // モデル名は今のところ固定値 (将来的には設定で切り替え可能にする)。
                // gpt-4o-mini-transcribe は安価でレイテンシが低い。
                let engine =
                    crate::openai_realtime::OpenAIRealtimeEngine::new("gpt-4o-mini-transcribe");
                self.engine = Some(Arc::new(engine));
            }
            TranscriptionEngineType::ElevenLabsRealtime => {
                let engine = crate::elevenlabs_realtime::ElevenLabsRealtimeEngine::new(
                    crate::elevenlabs_realtime::SCRIBE_V2_REALTIME_MODEL_ID,
                );
                self.engine = Some(Arc::new(engine));
            }
        }

        self.loaded_engine_signature = Some(signature);
        Ok(())
    }

    /// 停止フラグを取得する（スレッド間共有用）
    pub fn running_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.running)
    }

    /// 文字起こしを停止する
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────
// Tauri managed state
// ─────────────────────────────────────────────

pub struct TranscriptionStateHandle(pub Mutex<TranscriptionManager>);

impl TranscriptionStateHandle {
    pub fn new() -> Self {
        Self(Mutex::new(TranscriptionManager::new()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────
    // ensure_engine — エンジン種別ディスパッチ / 再ロード抑制
    // ─────────────────────────────────────────

    #[test]
    fn test_ensure_engine_apple_speech_errors_off_macos() {
        // 非 macOS では AppleSpeech は使えないので明示エラー。
        // Whisper 側の実装に切り替えてくださいというヒント文言を含む。
        // (macOS テスト環境ではこのテストは失敗するので skip する)
        if cfg!(target_os = "macos") {
            return;
        }
        let mut manager = TranscriptionManager::new();
        let err = manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::AppleSpeech,
                "small",
            )
            .unwrap_err();
        assert!(err.contains("macOS"));
    }

    #[test]
    fn test_ensure_engine_openai_loads_engine_without_api_key_check() {
        // OpenAI エンジンは start_stream 時に Keychain から API キーを取得するので、
        // ensure_engine 自体は成功する。実 WebSocket 接続は start_stream まで遅延する。
        let mut manager = TranscriptionManager::new();
        manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::OpenAIRealtime,
                "small",
            )
            .expect("OpenAI エンジンの ensure_engine は同期的には成功する");
        assert!(manager.is_engine_loaded());
    }

    #[test]
    fn test_ensure_engine_elevenlabs_loads_engine_without_api_key_check() {
        // ElevenLabs も start_stream 時に Keychain から API キーを取得する。
        // ensure_engine 自体は課金・通信を発生させず、同期的に成功する。
        let mut manager = TranscriptionManager::new();
        manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
                "small",
            )
            .expect("ElevenLabs エンジンの ensure_engine は同期的には成功する");
        assert!(manager.is_engine_loaded());
    }

    // ─────────────────────────────────────────
    // モデル未ダウンロード エラーパス テスト
    // ─────────────────────────────────────────

    #[test]
    fn load_model_returns_error_when_model_not_downloaded() {
        let mut manager = TranscriptionManager::new();
        let err = manager
            .load_model("__nonexistent_test_model_xyz_999__")
            .unwrap_err();
        assert!(
            err.starts_with("モデルがダウンロードされていません:"),
            "unexpected error: {err}"
        );
        assert!(!manager.is_engine_loaded());
    }

    #[test]
    fn ensure_engine_returns_error_when_whisper_model_not_downloaded() {
        let mut manager = TranscriptionManager::new();
        let err = manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::Whisper,
                "__nonexistent_test_model_xyz_999__",
            )
            .unwrap_err();
        assert!(
            err.starts_with("モデルがダウンロードされていません:"),
            "unexpected error: {err}"
        );
        assert!(!manager.is_engine_loaded());
        // 2 回目も Err: loaded_engine_signature が記録されていないことの間接確認
        let result2 = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__nonexistent_test_model_xyz_999__",
        );
        assert!(result2.is_err());
    }

    #[test]
    fn ensure_engine_does_not_set_engine_on_whisper_failure() {
        let mut manager = TranscriptionManager::new();
        let result = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__nonexistent_test_model_xyz_999__",
        );
        assert!(result.is_err());
        assert!(!manager.is_engine_loaded());
        // 別モデル名でも依然 Err: engine も signature も汚染されていない
        let result2 = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__another_nonexistent_test_model_999__",
        );
        assert!(result2.is_err());
    }
}
