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

const ELEVENLABS_REALTIME_SAMPLE_RATE: u32 = 16_000;

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

mod ws_task {
    use std::sync::Arc;
    use std::time::Duration;

    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use parking_lot::Mutex;
    use rubato::SincFixedIn;
    use serde_json::{json, Value};
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

    use crate::realtime_audio_helpers::{float_to_pcm16, resample_block};
    use crate::realtime_ws_helpers::{
        extract_error_message, extract_transcript, is_scribe_error_event,
        wait_for_pending_after_commit,
    };
    use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

    use super::{AudioCommand, ELEVENLABS_REALTIME_SAMPLE_RATE};

    const PENDING_AFTER_COMMIT_TIMEOUT: Duration = Duration::from_secs(10);

    pub struct RunParams {
        pub api_key: String,
        pub model_id: String,
        pub language: Option<String>,
        pub sample_rate: u32,
        pub audio_rx: UnboundedReceiver<AudioCommand>,
        pub pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
        pub speaker: Option<String>,
        pub source: Option<TranscriptionSource>,
    }

    pub async fn run(params: RunParams) -> Result<(), String> {
        let RunParams {
            api_key,
            model_id,
            language,
            sample_rate,
            mut audio_rx,
            pending,
            speaker,
            source,
        } = params;
        let url = build_realtime_url(&model_id, language.as_deref());
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("WebSocket リクエスト構築に失敗: {e}"))?;
        request.headers_mut().insert(
            "xi-api-key",
            api_key
                .parse()
                .map_err(|e| format!("xi-api-key ヘッダの構築に失敗: {e}"))?,
        );

        let (ws_stream, _resp) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("WebSocket 接続に失敗しました: {e}"))?;
        let (mut ws_tx, ws_rx) = ws_stream.split();

        let needs_resample = sample_rate != ELEVENLABS_REALTIME_SAMPLE_RATE;
        let mut resampler = if needs_resample {
            Some(
                SincFixedIn::<f32>::new(
                    ELEVENLABS_REALTIME_SAMPLE_RATE as f64 / sample_rate as f64,
                    2.0,
                    rubato::SincInterpolationParameters {
                        sinc_len: 256,
                        f_cutoff: 0.95,
                        interpolation: rubato::SincInterpolationType::Linear,
                        oversampling_factor: 256,
                        window: rubato::WindowFunction::BlackmanHarris2,
                    },
                    1024,
                    1,
                )
                .map_err(|e| format!("リサンプラー初期化失敗: {e}"))?,
            )
        } else {
            None
        };
        let mut resample_buf: Vec<f32> = Vec::new();

        let pending_for_reader = Arc::clone(&pending);
        let speaker_for_reader = speaker.clone();
        let source_for_reader = source;
        let reader_task = tokio::spawn(crate::realtime_reader_task::run_reader_task(
            ws_rx,
            pending_for_reader,
            speaker_for_reader,
            source_for_reader,
            "ElevenLabs",
            handle_event,
        ));

        let mut sent_finalize_commit = false;
        let mut pending_len_before_finalize = 0;
        while let Some(cmd) = audio_rx.recv().await {
            match cmd {
                AudioCommand::Samples(samples) => {
                    let resampled = resample_block(&mut resampler, &mut resample_buf, &samples)?;
                    if resampled.is_empty() {
                        continue;
                    }
                    let pcm16 = float_to_pcm16(&resampled);
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&pcm16);
                    let event = json!({
                        "message_type": "input_audio_chunk",
                        "audio_base_64": b64,
                        "sample_rate": ELEVENLABS_REALTIME_SAMPLE_RATE,
                        "commit": false
                    });
                    if let Err(e) = ws_tx.send(Message::Text(event.to_string())).await {
                        return Err(format!("音声送信に失敗: {e}"));
                    }
                }
                AudioCommand::Finalize => {
                    let commit = json!({
                        "message_type": "input_audio_chunk",
                        "audio_base_64": "",
                        "sample_rate": ELEVENLABS_REALTIME_SAMPLE_RATE,
                        "commit": true
                    });
                    pending_len_before_finalize = pending.lock().len();
                    let _ = ws_tx.send(Message::Text(commit.to_string())).await;
                    sent_finalize_commit = true;
                    break;
                }
            }
        }

        if sent_finalize_commit {
            wait_for_pending_after_commit(
                &pending,
                pending_len_before_finalize,
                PENDING_AFTER_COMMIT_TIMEOUT,
            )
            .await;
        }
        let _ = ws_tx.send(Message::Close(None)).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), reader_task).await;

        Ok(())
    }

    pub(crate) fn build_realtime_url(model_id: &str, language: Option<&str>) -> String {
        let mut url = format!(
            "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id={model_id}&audio_format=pcm_16000&commit_strategy=vad",
        );
        if let Some(language) = language.map(str::trim).filter(|value| !value.is_empty()) {
            if language != "auto" {
                url.push_str("&language_code=");
                url.push_str(language);
            }
        }
        url
    }

    pub(crate) fn handle_event(
        text: &str,
        pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
        speaker: &Option<String>,
        source: Option<TranscriptionSource>,
    ) {
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return,
        };
        let event_type = value
            .get("message_type")
            .or_else(|| value.get("type"))
            .and_then(|v| v.as_str());

        match event_type {
            Some("committed_transcript") | Some("committed_transcript_with_timestamps") => {
                if let Some(transcript) = extract_transcript(&value) {
                    let trimmed = transcript.trim();
                    if !trimmed.is_empty() {
                        pending.lock().push(TranscriptionSegment {
                            text: trimmed.to_string(),
                            start_ms: 0,
                            end_ms: 0,
                            source,
                            speaker: speaker.clone(),
                            is_error: None,
                        });
                    }
                }
            }
            Some("error") | Some("transcription_error") => {
                if let Some(message) = extract_error_message(&value) {
                    crate::realtime_error_helpers::push_error(
                        "ElevenLabs",
                        pending,
                        speaker,
                        source,
                        message,
                    );
                }
            }
            Some(event_name) if is_scribe_error_event(event_name) => {
                if let Some(message) = extract_error_message(&value) {
                    crate::realtime_error_helpers::push_error(
                        "ElevenLabs",
                        pending,
                        speaker,
                        source,
                        message,
                    );
                }
            }
            _ => {}
        }
    }

    #[cfg(test)]
    mod pending_timeout_tests {
        use std::sync::Arc;

        use parking_lot::Mutex;

        use crate::transcription_types::TranscriptionSegment;
        use crate::transcription_types::TranscriptionSource;

        #[test]
        fn push_error_format_prefix_and_suffix_are_fixed() {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());

            crate::realtime_error_helpers::push_error(
                "ElevenLabs",
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "connection closed".to_string(),
            );

            let segments = pending.lock();
            assert_eq!(segments.len(), 1);
            // prefix と suffix を含む完全一致で文言契約を強制。
            assert_eq!(
                segments[0].text,
                "[ElevenLabs Realtime エラー: connection closed]"
            );
        }

        #[test]
        fn push_error_sets_zero_timestamps_and_is_error_true() {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());

            crate::realtime_error_helpers::push_error(
                "ElevenLabs",
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "rate limit".to_string(),
            );

            let segments = pending.lock();
            assert_eq!(segments.len(), 1);
            // エラーセグメント identity 契約: 時刻情報なし + is_error=Some(true)
            assert_eq!(segments[0].start_ms, 0);
            assert_eq!(segments[0].end_ms, 0);
            assert_eq!(segments[0].is_error, Some(true));
        }

        #[test]
        fn push_error_passes_source_through() {
            // ケース 1: Some(Microphone) は Some(Microphone) のまま渡る
            {
                let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                    Arc::new(Mutex::new(Vec::new()));
                let speaker = Some("自分".to_string());
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending,
                    &speaker,
                    Some(TranscriptionSource::Microphone),
                    "err".to_string(),
                );
                assert_eq!(
                    pending.lock()[0].source,
                    Some(TranscriptionSource::Microphone)
                );
            }

            // ケース 2: None は None のまま渡る
            {
                let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                    Arc::new(Mutex::new(Vec::new()));
                let speaker = Some("自分".to_string());
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending,
                    &speaker,
                    None,
                    "err".to_string(),
                );
                assert_eq!(pending.lock()[0].source, None);
            }
        }

        #[test]
        fn push_error_clones_speaker_field() {
            // ケース 1: Some("自分") が clone されて渡る (元の所有権は保持される)
            {
                let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                    Arc::new(Mutex::new(Vec::new()));
                let speaker = Some("自分".to_string());
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending,
                    &speaker,
                    Some(TranscriptionSource::Microphone),
                    "err".to_string(),
                );
                assert_eq!(pending.lock()[0].speaker, Some("自分".to_string()));
                // 元の speaker が clone 後も有効であることを確認 (move されていない)
                assert_eq!(speaker, Some("自分".to_string()));
            }

            // ケース 2: None は None のまま渡る
            {
                let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                    Arc::new(Mutex::new(Vec::new()));
                let speaker: Option<String> = None;
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending,
                    &speaker,
                    Some(TranscriptionSource::Microphone),
                    "err".to_string(),
                );
                assert_eq!(pending.lock()[0].speaker, None);
            }
        }

        #[test]
        fn push_error_with_empty_and_multibyte_messages_preserve_text_format() {
            // ケース 1: 空 message でも prefix/suffix が残り "[ElevenLabs Realtime エラー: ]" になる
            {
                let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                    Arc::new(Mutex::new(Vec::new()));
                let speaker = Some("自分".to_string());
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending,
                    &speaker,
                    Some(TranscriptionSource::Microphone),
                    "".to_string(),
                );
                assert_eq!(pending.lock()[0].text, "[ElevenLabs Realtime エラー: ]");
            }

            // ケース 2: 日本語マルチバイト message が prefix/suffix の間にそのまま埋め込まれる
            {
                let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                    Arc::new(Mutex::new(Vec::new()));
                let speaker = Some("自分".to_string());
                crate::realtime_error_helpers::push_error(
                    "ElevenLabs",
                    &pending,
                    &speaker,
                    Some(TranscriptionSource::Microphone),
                    "認証エラーが発生しました".to_string(),
                );
                assert_eq!(
                    pending.lock()[0].text,
                    "[ElevenLabs Realtime エラー: 認証エラーが発生しました]"
                );
            }
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
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let speaker = Some("相手側".to_string());

        ws_task::handle_event(
            r#"{"message_type":"scribe_auth_error","message":"invalid api key"}"#,
            &pending,
            &speaker,
            Some(TranscriptionSource::SystemAudio),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 1);
        assert!(segments[0].text.contains("invalid api key"));
        assert_eq!(segments[0].speaker, speaker);
        assert_eq!(segments[0].source, Some(TranscriptionSource::SystemAudio));
        assert_eq!(segments[0].is_error, Some(true));
    }

    #[test]
    fn engine_default_debug_format_contains_type_name_and_empty_model_id_field() {
        let engine = ElevenLabsRealtimeEngine::default();
        let formatted = format!("{engine:?}");
        assert!(
            formatted.contains("ElevenLabsRealtimeEngine"),
            "型名: {formatted}"
        );
        assert!(formatted.contains("model_id"), "field 名: {formatted}");
        assert!(
            formatted.contains("\"\""),
            "空 String を Debug 出力: {formatted}"
        );
    }

    #[test]
    fn engine_new_with_str_slice_debug_format_contains_provided_model_id_value() {
        let engine = ElevenLabsRealtimeEngine::new("scribe_v2_realtime");
        let formatted = format!("{engine:?}");
        assert!(formatted.contains("ElevenLabsRealtimeEngine"));
        assert!(formatted.contains("model_id"));
        assert!(formatted.contains("\"scribe_v2_realtime\""));
    }

    #[test]
    fn engine_new_with_owned_string_debug_format_contains_provided_model_id_value() {
        let engine = ElevenLabsRealtimeEngine::new(String::from("scribe_v2_legacy"));
        let formatted = format!("{engine:?}");
        assert!(formatted.contains("ElevenLabsRealtimeEngine"));
        assert!(formatted.contains("model_id"));
        assert!(formatted.contains("\"scribe_v2_legacy\""));
    }

    #[test]
    fn audio_command_samples_variant_debug_format_contains_variant_name_and_payload_floats() {
        let cmd = AudioCommand::Samples(vec![1.0_f32, -0.5, 0.0]);
        let formatted = format!("{cmd:?}");
        assert!(formatted.contains("Samples"), "variant 名: {formatted}");
        assert!(formatted.contains("1.0"), "first sample: {formatted}");
        assert!(formatted.contains("-0.5"), "second sample: {formatted}");
        assert!(formatted.contains("0.0"), "third sample: {formatted}");
    }

    #[test]
    fn audio_command_finalize_variant_debug_format_is_exact_variant_name() {
        let cmd = AudioCommand::Finalize;
        let formatted = format!("{cmd:?}");
        assert_eq!(formatted, "Finalize", "完全一致: {formatted}");
        assert!(formatted.contains("Finalize"));
    }

    #[test]
    fn audio_command_samples_with_empty_vec_debug_format_contains_variant_name_and_empty_brackets()
    {
        let cmd = AudioCommand::Samples(vec![]);
        let formatted = format!("{cmd:?}");
        assert!(formatted.contains("Samples"), "variant 名: {formatted}");
        assert!(
            formatted.contains("[]"),
            "空 Vec の Debug 表示: {formatted}"
        );
        assert!(
            formatted.contains("Samples([])"),
            "tuple variant 形式: {formatted}"
        );
    }
}
