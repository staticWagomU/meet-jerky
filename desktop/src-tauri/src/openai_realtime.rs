//! OpenAI Realtime API を `TranscriptionEngine` の実装として
//! 統合するモジュール。
//!
//! プロトコル概要 (intent=transcription):
//! - WebSocket: `wss://api.openai.com/v1/realtime?intent=transcription`
//! - 認証: `Authorization: Bearer <API_KEY>` + `OpenAI-Beta: realtime=v1`
//! - 送信:
//!   - `transcription_session.update` でモデル/音声フォーマット設定
//!   - `input_audio_buffer.append` で base64 PCM16 音声を逐次送信
//! - 受信:
//!   - `conversation.item.input_audio_transcription.delta` (部分)
//!   - `conversation.item.input_audio_transcription.completed` (確定)
//!   - `error` (エラー)
//!
//! API_VERIFY: 上記プロトコルは公開ドキュメント時点 (2025) のもの。
//! API のフィールド名・イベント名は実機で確認が必要。
//!
//! 同期 trait と非同期 WebSocket の橋渡し:
//! - `feed()` (sync) は `mpsc::UnboundedSender<Vec<f32>>` に push するだけ。
//! - 別の async タスクが受信して resample → PCM16 → base64 → WS 送信。
//! - 結果イベントは `Mutex<Vec<TranscriptionSegment>>` に積み、
//!   `drain_segments()` (sync) が取り出す。

use std::sync::Arc;

use parking_lot::Mutex;

use crate::openai_realtime_ws_task as ws_task;
use crate::realtime_audio_command::AudioCommand;
use crate::secret_store::{get_secret, SecretKey};
use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};
use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

/// OpenAI Realtime API のエンジン。
///
/// `start_stream` のたびに Keychain から API キーを取り直すので、
/// キーがローテーションされた場合は次のセッションから新しい値が使われる。
#[derive(Debug, Default)]
pub struct OpenAIRealtimeEngine {
    /// 文字起こし用モデル名。`gpt-4o-mini-transcribe` または `gpt-4o-transcribe` 等。
    pub model: String,
}

impl OpenAIRealtimeEngine {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
        }
    }
}

impl TranscriptionEngine for OpenAIRealtimeEngine {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String> {
        let api_key = get_secret(SecretKey::OpenAIApiKey)?.ok_or_else(|| {
            "OpenAI Realtime の利用には、設定画面で API キーを登録してください。".to_string()
        })?;

        let stream = OpenAIRealtimeStream::new(self.model.clone(), api_key, config)?;
        Ok(Box::new(stream))
    }
}

// ─────────────────────────────────────────────
// OpenAIRealtimeStream
// ─────────────────────────────────────────────

pub struct OpenAIRealtimeStream {
    audio_tx: tokio::sync::mpsc::UnboundedSender<AudioCommand>,
    pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: Option<String>,
    source: Option<TranscriptionSource>,
    /// `tauri::async_runtime::spawn` の戻り値。Drop 時にキャンセルする。
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl OpenAIRealtimeStream {
    pub fn new(model: String, api_key: String, config: StreamConfig) -> Result<Self, String> {
        crate::install_rustls_crypto_provider();

        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let (audio_tx, audio_rx) = tokio::sync::mpsc::unbounded_channel::<AudioCommand>();

        let pending_for_task = Arc::clone(&pending);
        let speaker = config.speaker.clone();
        let source = config.source;
        let language = config.language.clone();
        let sample_rate = config.sample_rate;

        let task_handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = ws_task::run(ws_task::RunParams {
                api_key,
                model,
                language,
                sample_rate,
                audio_rx,
                pending: pending_for_task.clone(),
                speaker: speaker.clone(),
                source,
            })
            .await
            {
                // タスク内で発生した致命的エラーをユーザーにも分かるように
                // pending キューに 1 件だけ詰める (segment text に流す簡易方式)。
                crate::realtime_error_helpers::push_error(
                    "OpenAI",
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

impl TranscriptionStream for OpenAIRealtimeStream {
    fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        self.audio_tx
            .send(AudioCommand::Samples(samples.to_vec()))
            .map_err(|_| "OpenAI Realtime ストリームが既に停止しています".to_string())?;
        Ok(())
    }

    fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
        let mut q = self.pending.lock();
        std::mem::take(&mut *q)
    }

    fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
        // タスクに入力終了を通知。送信失敗はタスクが既に終わっているだけなので無視。
        let _ = self.audio_tx.send(AudioCommand::Finalize);

        // WS タスクの完了待ち。Tauri runtime 上で待機する。
        if let Some(handle) = self.task_handle.take() {
            // block_on は呼び出し元 (run_transcription_loop) が同期スレッドなので OK。
            tauri::async_runtime::block_on(async move {
                let _ = handle.await;
            });
        }

        // 残りの pending を返す
        let mut q = self.pending.lock();
        let _ = &self.speaker; // suppress unused warning if any
        let _ = &self.source; // suppress unused warning if any
        Ok(std::mem::take(&mut *q))
    }
}

impl Drop for OpenAIRealtimeStream {
    fn drop(&mut self) {
        // finalize が呼ばれずに落ちた場合の保険。タスクをキャンセルする。
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_construction_records_model() {
        let engine = OpenAIRealtimeEngine::new("gpt-4o-mini-transcribe");
        assert_eq!(engine.model, "gpt-4o-mini-transcribe");
    }

    #[test]
    fn error_events_are_queued_as_error_segments() {
        crate::realtime_error_helpers::test_helpers::assert_handle_event_error_payload_creates_error_segment(
            ws_task::handle_event,
            r#"{"type":"error","error":{"message":"connection closed"}}"#,
            "自分",
            TranscriptionSource::Microphone,
            "connection closed",
        );
    }

    #[test]
    fn handle_event_pushes_completed_transcript() {
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let speaker = Some("自分".to_string());

        ws_task::handle_event(
            r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"会議の内容です"}"#,
            &pending,
            &speaker,
            Some(TranscriptionSource::Microphone),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "会議の内容です");
        assert_eq!(segments[0].is_error, None);
        assert_eq!(segments[0].speaker, speaker);
        assert_eq!(segments[0].source, Some(TranscriptionSource::Microphone));
    }

    #[test]
    fn handle_event_ignores_delta_events() {
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let speaker = Some("自分".to_string());

        ws_task::handle_event(
            r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"会"}"#,
            &pending,
            &speaker,
            Some(TranscriptionSource::Microphone),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 0);
    }

    #[test]
    fn handle_event_pushes_error_message() {
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let speaker = Some("自分".to_string());

        ws_task::handle_event(
            r#"{"type":"error","error":{"message":"rate limit exceeded"}}"#,
            &pending,
            &speaker,
            Some(TranscriptionSource::Microphone),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].is_error, Some(true));
        assert!(segments[0].text.contains("rate limit exceeded"));
    }

    #[test]
    fn handle_event_handles_multiple_completed_events_sequentially() {
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let speaker = Some("自分".to_string());

        for text in &["第一発言", "第二発言", "第三発言"] {
            let json = format!(
                r#"{{"type":"conversation.item.input_audio_transcription.completed","transcript":"{text}"}}"#
            );
            ws_task::handle_event(
                &json,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
        }

        let segments = pending.lock();
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].text, "第一発言");
        assert_eq!(segments[1].text, "第二発言");
        assert_eq!(segments[2].text, "第三発言");
    }

    #[test]
    fn handle_event_ignores_invalid_json() {
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let speaker = Some("自分".to_string());

        ws_task::handle_event(
            "not valid json {{{",
            &pending,
            &speaker,
            Some(TranscriptionSource::Microphone),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 0);
    }

    #[test]
    fn push_error_format_prefix_and_suffix_are_fixed() {
        crate::realtime_error_helpers::test_helpers::assert_push_error_format_prefix_and_suffix_are_fixed("OpenAI");
    }

    #[test]
    fn push_error_sets_zero_timestamps_and_is_error_true() {
        crate::realtime_error_helpers::test_helpers::assert_push_error_sets_zero_timestamps_and_is_error_true("OpenAI");
    }

    #[test]
    fn push_error_passes_source_through() {
        crate::realtime_error_helpers::test_helpers::assert_push_error_passes_source_through(
            "OpenAI",
        );
    }

    #[test]
    fn push_error_clones_speaker_field() {
        crate::realtime_error_helpers::test_helpers::assert_push_error_clones_speaker_field(
            "OpenAI",
        );
    }

    #[test]
    fn push_error_with_empty_and_multibyte_messages_preserve_text_format() {
        crate::realtime_error_helpers::test_helpers::assert_push_error_with_empty_and_multibyte_messages_preserve_text_format("OpenAI");
    }

    #[test]
    fn handle_event_ignores_completed_event_when_transcript_field_is_non_string() {
        let speaker = Some("自分".to_string());

        // ケース 1: transcript=null
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":null}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "transcript=null は as_str() で None、silent return のはず"
            );
        }

        // ケース 2: transcript=number
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":42}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "transcript=number は as_str() で None、silent return のはず"
            );
        }

        // ケース 3: transcript=array
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":["a","b"]}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "transcript=array は as_str() で None、silent return のはず"
            );
        }
    }

    #[test]
    fn handle_event_ignores_completed_event_when_transcript_is_whitespace_only_or_empty() {
        let speaker = Some("自分".to_string());
        // 4 種の空白系 + 全角空白 (U+3000) を一気に網羅。すべて trim 後 empty で push されない。
        for transcript in &["", "   ", "\t", "\n\n", "　　"] {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            let json = format!(
                r#"{{"type":"conversation.item.input_audio_transcription.completed","transcript":"{transcript}"}}"#
            );
            ws_task::handle_event(
                &json,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "trim 後 empty な transcript={transcript:?} では push されないはず"
            );
        }
    }

    #[test]
    fn handle_event_does_not_push_error_when_error_message_is_non_string() {
        let speaker = Some("自分".to_string());

        // ケース 1: error.message=null
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error","error":{"message":null}}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "error.message=null は as_str() で None、push_error されないはず"
            );
        }

        // ケース 2: error.message=number
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error","error":{"message":500}}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "error.message=number は as_str() で None、push_error されないはず"
            );
        }

        // ケース 3: error.message=array
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error","error":{"message":["nested","array"]}}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "error.message=array は as_str() で None、push_error されないはず"
            );
        }
    }

    #[test]
    fn handle_event_does_not_push_error_when_error_lacks_message_field() {
        let speaker = Some("自分".to_string());

        // ケース 1: error: {} (message field 無し)
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error","error":{}}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "error: {{}} は message が None、push_error されないはず"
            );
        }

        // ケース 2: error: null
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error","error":null}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "error: null は get(\"message\") が None、push_error されないはず"
            );
        }

        // ケース 3: error が flat string (nested object じゃない)
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error","error":"something went wrong"}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            // 重要: openai 側は elevenlabs と違い flat string への fallback は持たない (実装 line 408-413 は nested message のみ参照)
            assert_eq!(
                pending.lock().len(),
                0,
                "error が flat string でも nested message は無いので push_error されないはず (elevenlabs との差分契約)"
            );
        }

        // ケース 4: error field 自体無し
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":"error"}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "error field 自体無しなら push_error されないはず"
            );
        }
    }

    #[test]
    fn handle_event_returns_silently_when_type_field_is_non_string_or_missing() {
        let speaker = Some("自分".to_string());

        // ケース 1: type=null (transcript はあっても処理されない)
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":null,"transcript":"would-be-ignored"}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "type=null は as_str() で None、silent return のはず"
            );
        }

        // ケース 2: type=number
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":42,"error":{"message":"would-be-ignored"}}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "type=number は as_str() で None、silent return のはず"
            );
        }

        // ケース 3: type=array
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"type":["error"],"error":{"message":"would-be-ignored"}}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "type=array は as_str() で None、silent return のはず"
            );
        }

        // ケース 4: type field 自体無し (空 object 含む)
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{"transcript":"orphan"}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "type field 自体無しなら silent return のはず"
            );
        }

        // ケース 5: 完全空 object
        {
            let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
            ws_task::handle_event(
                r#"{}"#,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
            );
            assert_eq!(
                pending.lock().len(),
                0,
                "完全空 object は type 無しと同義、silent return のはず"
            );
        }
    }

    #[test]
    fn engine_default_debug_format_contains_type_name_and_empty_model_field() {
        let engine = OpenAIRealtimeEngine::default();
        let formatted = format!("{engine:?}");
        crate::realtime_audio_command::test_helpers::assert_engine_default_debug_format(
            &formatted,
            "OpenAIRealtimeEngine",
            "model",
        );
    }

    #[test]
    fn engine_new_with_str_slice_debug_format_contains_provided_model_value() {
        let engine = OpenAIRealtimeEngine::new("gpt-4o-mini-transcribe");
        let formatted = format!("{engine:?}");
        crate::realtime_audio_command::test_helpers::assert_engine_with_model_value_debug_format(
            &formatted,
            "OpenAIRealtimeEngine",
            "model",
            "gpt-4o-mini-transcribe",
        );
    }

    #[test]
    fn engine_new_with_owned_string_debug_format_contains_provided_model_value() {
        let engine = OpenAIRealtimeEngine::new(String::from("gpt-4o-transcribe"));
        let formatted = format!("{engine:?}");
        crate::realtime_audio_command::test_helpers::assert_engine_with_model_value_debug_format(
            &formatted,
            "OpenAIRealtimeEngine",
            "model",
            "gpt-4o-transcribe",
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
