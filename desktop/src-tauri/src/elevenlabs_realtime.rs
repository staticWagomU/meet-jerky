//! ElevenLabs Scribe v2 Realtime を `TranscriptionEngine` の実装として
//! 統合するモジュール。
//!
//! プロトコル概要:
//! - WebSocket: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
//! - 認証: `xi-api-key: <API_KEY>`
//! - query: `model_id=scribe_v2_realtime` は必須
//! - 送信: `message_type=input_audio_chunk`, `audio_base_64`, `sample_rate`
//! - 受信: `committed_transcript` / `committed_transcript_with_timestamps`
//!
//! API_VERIFY: 課金が発生する実通信はこの環境では行わない。フィールド名は
//! 公式ドキュメント時点の仕様に合わせ、ライブ疎通は API キーを持つ環境で行う。

use std::sync::Arc;

use parking_lot::Mutex;

use crate::elevenlabs_realtime_ws_task as ws_task;
use crate::realtime_audio_command::AudioCommand;
use crate::secret_store::{get_secret, SecretKey};
use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};
use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

pub const SCRIBE_V2_REALTIME_MODEL_ID: &str = "scribe_v2_realtime";

#[derive(Debug, Default)]
pub struct ElevenLabsRealtimeEngine {
    pub model_id: String,
}

impl ElevenLabsRealtimeEngine {
    pub fn new(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
        }
    }
}

impl TranscriptionEngine for ElevenLabsRealtimeEngine {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String> {
        let api_key = get_secret(SecretKey::ElevenLabsApiKey)?.ok_or_else(|| {
            "ElevenLabs Realtime の利用には、設定画面で API キーを登録してください。".to_string()
        })?;

        let stream = ElevenLabsRealtimeStream::new(self.model_id.clone(), api_key, config)?;
        Ok(Box::new(stream))
    }
}

pub struct ElevenLabsRealtimeStream {
    audio_tx: tokio::sync::mpsc::UnboundedSender<AudioCommand>,
    pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: Option<String>,
    source: Option<TranscriptionSource>,
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl ElevenLabsRealtimeStream {
    pub fn new(model_id: String, api_key: String, config: StreamConfig) -> Result<Self, String> {
        crate::install_rustls_crypto_provider();

        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let (audio_tx, audio_rx) = tokio::sync::mpsc::unbounded_channel::<AudioCommand>();

        let pending_for_task = Arc::clone(&pending);
        let speaker = config.speaker.clone();
        let source = config.source;
        let sample_rate = config.sample_rate;
        let language = config.language.clone();

        let task_handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = ws_task::run(ws_task::RunParams {
                api_key,
                model_id,
                language,
                sample_rate,
                audio_rx,
                pending: pending_for_task.clone(),
                speaker: speaker.clone(),
                source,
            })
            .await
            {
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending_for_task,
                    &speaker,
                    source,
                    e,
                );
            }
        });

        Ok(Self {
            audio_tx,
            pending,
            speaker: config.speaker,
            source: config.source,
            task_handle: Some(task_handle),
        })
    }
}

impl TranscriptionStream for ElevenLabsRealtimeStream {
    fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        self.audio_tx
            .send(AudioCommand::Samples(samples.to_vec()))
            .map_err(|_| "ElevenLabs Realtime ストリームが既に停止しています".to_string())?;
        Ok(())
    }

    fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
        let mut q = self.pending.lock();
        std::mem::take(&mut *q)
    }

    fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
        let _ = self.audio_tx.send(AudioCommand::Finalize);
        if let Some(handle) = self.task_handle.take() {
            tauri::async_runtime::block_on(async move {
                let _ = handle.await;
            });
        }
        let mut q = self.pending.lock();
        let _ = &self.speaker;
        let _ = &self.source;
        Ok(std::mem::take(&mut *q))
    }
}

impl Drop for ElevenLabsRealtimeStream {
    fn drop(&mut self) {
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_url_uses_scribe_v2_pcm16_and_vad() {
        let url = ws_task::build_realtime_url(SCRIBE_V2_REALTIME_MODEL_ID, None);
        assert!(url.contains("model_id=scribe_v2_realtime"));
        assert!(url.contains("audio_format=pcm_16000"));
        assert!(url.contains("commit_strategy=vad"));
        assert!(!url.contains("language_code="));
    }

    #[test]
    fn realtime_url_includes_explicit_language_hint() {
        let url = ws_task::build_realtime_url(SCRIBE_V2_REALTIME_MODEL_ID, Some("ja"));
        assert!(url.contains("language_code=ja"));
        let auto_url = ws_task::build_realtime_url(SCRIBE_V2_REALTIME_MODEL_ID, Some("auto"));
        assert!(!auto_url.contains("language_code="));
    }

    #[test]
    fn engine_construction_records_model_id() {
        let engine = ElevenLabsRealtimeEngine::new(SCRIBE_V2_REALTIME_MODEL_ID);
        assert_eq!(engine.model_id, SCRIBE_V2_REALTIME_MODEL_ID);
    }

    #[test]
    fn scribe_error_events_are_queued_as_error_segments() {
        crate::realtime_error_helpers::test_helpers::assert_handle_event_error_payload_creates_error_segment(
            ws_task::handle_event,
            r#"{"message_type":"scribe_auth_error","message":"invalid api key"}"#,
            "相手側",
            TranscriptionSource::SystemAudio,
            "invalid api key",
        );
    }

    #[test]
    fn engine_default_debug_format_contains_type_name_and_empty_model_id_field() {
        let engine = ElevenLabsRealtimeEngine::default();
        let formatted = format!("{engine:?}");
        crate::realtime_audio_command::test_helpers::assert_engine_default_debug_format(
            &formatted,
            "ElevenLabsRealtimeEngine",
            "model_id",
        );
    }

    #[test]
    fn engine_new_with_str_slice_debug_format_contains_provided_model_id_value() {
        let engine = ElevenLabsRealtimeEngine::new("scribe_v2_realtime");
        let formatted = format!("{engine:?}");
        crate::realtime_audio_command::test_helpers::assert_engine_with_model_value_debug_format(
            &formatted,
            "ElevenLabsRealtimeEngine",
            "model_id",
            "scribe_v2_realtime",
        );
    }

    #[test]
    fn engine_new_with_owned_string_debug_format_contains_provided_model_id_value() {
        let engine = ElevenLabsRealtimeEngine::new(String::from("scribe_v2_legacy"));
        let formatted = format!("{engine:?}");
        crate::realtime_audio_command::test_helpers::assert_engine_with_model_value_debug_format(
            &formatted,
            "ElevenLabsRealtimeEngine",
            "model_id",
            "scribe_v2_legacy",
        );
    }

    #[test]
    fn audio_command_samples_variant_debug_format_contains_variant_name_and_payload_floats() {
        crate::realtime_audio_command::test_helpers::assert_samples_variant_debug_format_contains_variant_name_and_payload_floats();
    }

    #[test]
    fn audio_command_finalize_variant_debug_format_is_exact_variant_name() {
        crate::realtime_audio_command::test_helpers::assert_finalize_variant_debug_format_is_exact_variant_name();
    }

    #[test]
    fn audio_command_samples_with_empty_vec_debug_format_contains_variant_name_and_empty_brackets()
    {
        crate::realtime_audio_command::test_helpers::assert_samples_with_empty_vec_debug_format_contains_variant_name_and_empty_brackets();
    }
}
