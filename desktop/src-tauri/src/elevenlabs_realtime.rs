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
                pending_for_task.lock().push(TranscriptionSegment {
                    text: format!("[ElevenLabs Realtime エラー: {e}]"),
                    start_ms: 0,
                    end_ms: 0,
                    source,
                    speaker: speaker.clone(),
                    is_error: Some(true),
                });
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
        let (mut ws_tx, mut ws_rx) = ws_stream.split();

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
        let reader_task = tokio::spawn(async move {
            while let Some(msg) = ws_rx.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        crate::realtime_error_helpers::push_error(
                            "ElevenLabs",
                            &pending_for_reader,
                            &speaker_for_reader,
                            source_for_reader,
                            e.to_string(),
                        );
                        break;
                    }
                };
                match msg {
                    Message::Text(text) => {
                        handle_event(
                            &text,
                            &pending_for_reader,
                            &speaker_for_reader,
                            source_for_reader,
                        );
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

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

    fn is_scribe_error_event(event_name: &str) -> bool {
        event_name.starts_with("scribe_") && event_name.ends_with("_error")
    }

    // commit 送信後、ElevenLabs Realtime の最終 committed_transcript 到着を最大 timeout 秒待つ。
    // 長めの最終発話による取りこぼしを抑制するための値で、OpenAI 側 READER_FINALIZE_TIMEOUT と整合させている。
    async fn wait_for_pending_after_commit(
        pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
        previous_len: usize,
        timeout: Duration,
    ) {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if pending.lock().len() > previous_len {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn extract_transcript(value: &Value) -> Option<String> {
        value
            .get("transcript")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("text").and_then(|v| v.as_str()))
            .map(str::to_string)
            .or_else(|| {
                value.get("words").and_then(|v| v.as_array()).map(|words| {
                    words
                        .iter()
                        .filter_map(|word| {
                            word.get("text")
                                .or_else(|| word.get("word"))
                                .and_then(|v| v.as_str())
                        })
                        .collect::<Vec<_>>()
                        .join("")
                })
            })
    }

    fn extract_error_message(value: &Value) -> Option<String> {
        value
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("error").and_then(|v| v.as_str()))
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.as_str())
            })
            .map(str::to_string)
    }

    #[cfg(test)]
    mod pending_timeout_tests {
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        use parking_lot::Mutex;

        use crate::transcription_types::TranscriptionSegment;
        use crate::transcription_types::TranscriptionSource;

        use super::wait_for_pending_after_commit;

        fn make_segment() -> TranscriptionSegment {
            TranscriptionSegment {
                text: "segment".to_string(),
                start_ms: 0,
                end_ms: 0,
                source: None,
                speaker: None,
                is_error: None,
            }
        }

        #[tokio::test]
        async fn wait_for_pending_after_commit_returns_when_pending_grows() {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(vec![]));
            let clone = Arc::clone(&pending);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                clone.lock().push(make_segment());
            });
            let t = Instant::now();
            wait_for_pending_after_commit(&pending, 0, Duration::from_millis(500)).await;
            assert_eq!(
                pending.lock().len(),
                1,
                "pending が成長したら早期 return するはず"
            );
            assert!(
                t.elapsed() < Duration::from_millis(400),
                "deadline より早く return するはず"
            );
        }

        #[tokio::test]
        async fn wait_for_pending_after_commit_returns_after_deadline_when_pending_unchanged() {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(vec![]));
            let t = Instant::now();
            wait_for_pending_after_commit(&pending, 0, Duration::from_millis(150)).await;
            assert!(
                t.elapsed() >= Duration::from_millis(100),
                "deadline 経過後に return するはず"
            );
            assert_eq!(pending.lock().len(), 0);
        }

        #[tokio::test]
        async fn wait_for_pending_after_commit_returns_immediately_when_already_grown() {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
                Arc::new(Mutex::new(vec![make_segment()]));
            let t = Instant::now();
            wait_for_pending_after_commit(&pending, 0, Duration::from_secs(10)).await;
            assert!(
                t.elapsed() < Duration::from_millis(100),
                "既に pending > previous_len なら即 return するはず"
            );
        }

        #[test]
        fn is_scribe_error_event_returns_true_for_scribe_prefix_and_error_suffix() {
            assert!(super::is_scribe_error_event("scribe_validation_error"));
            assert!(super::is_scribe_error_event("scribe_audio_error"));
            assert!(super::is_scribe_error_event(
                "scribe_some_long_underscore_error"
            ));
        }

        #[test]
        fn is_scribe_error_event_returns_false_when_either_prefix_or_suffix_missing() {
            assert!(!super::is_scribe_error_event("scribe_audio"));
            assert!(!super::is_scribe_error_event("audio_error"));
            assert!(!super::is_scribe_error_event(""));
            assert!(!super::is_scribe_error_event("non_scribe_error"));
            assert!(!super::is_scribe_error_event("SCRIBE_ERROR"));
        }

        #[test]
        fn extract_transcript_prefers_transcript_field_over_text_field() {
            let value = serde_json::json!({ "transcript": "hello", "text": "ignored" });
            assert_eq!(super::extract_transcript(&value), Some("hello".to_string()));

            let value = serde_json::json!({ "text": "fallback only" });
            assert_eq!(
                super::extract_transcript(&value),
                Some("fallback only".to_string())
            );
        }

        #[test]
        fn extract_transcript_falls_back_to_words_array_with_text_or_word_keys() {
            let value = serde_json::json!({
                "words": [{"text": "hello"}, {"word": " world"}, {"text": "!"}]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("hello world!".to_string())
            );

            let value = serde_json::json!({ "words": [] });
            assert_eq!(super::extract_transcript(&value), Some("".to_string()));

            let value = serde_json::json!({ "words": [{"unrelated": "x"}] });
            assert_eq!(super::extract_transcript(&value), Some("".to_string()));
        }

        #[test]
        fn extract_transcript_returns_none_when_no_relevant_field_present() {
            let value = serde_json::json!({});
            assert_eq!(super::extract_transcript(&value), None);

            let value = serde_json::json!({ "unrelated": "x", "other": 42 });
            assert_eq!(super::extract_transcript(&value), None);

            let value = serde_json::json!({ "transcript": 123 });
            assert_eq!(super::extract_transcript(&value), None);
        }

        #[test]
        fn extract_error_message_traverses_three_priority_paths() {
            let value = serde_json::json!({ "message": "top-level message", "error": "ignored" });
            assert_eq!(
                super::extract_error_message(&value),
                Some("top-level message".to_string())
            );

            let value = serde_json::json!({ "error": "string-error" });
            assert_eq!(
                super::extract_error_message(&value),
                Some("string-error".to_string())
            );

            let value = serde_json::json!({ "error": { "message": "nested" } });
            assert_eq!(
                super::extract_error_message(&value),
                Some("nested".to_string())
            );

            let value = serde_json::json!({});
            assert_eq!(super::extract_error_message(&value), None);
        }

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

        #[test]
        fn is_scribe_error_event_returns_true_for_minimal_overlap_scribe_error() {
            // prefix と suffix が共有 _ で接する最短形も true になる現契約を固定。
            assert!(super::is_scribe_error_event("scribe_error"));
            assert!(super::is_scribe_error_event("scribe_x_error"));
        }

        #[test]
        fn is_scribe_error_event_returns_true_for_zero_length_middle_scribe_double_underscore_error(
        ) {
            // "scribe__error" は独立した _ 2 個で && 最小条件を真に満たす。中間 0 長も true の boundary を固定。
            assert!(super::is_scribe_error_event("scribe__error"));
            assert!(super::is_scribe_error_event("scribe_a_error"));
            assert!(!super::is_scribe_error_event("scribe"));
            assert!(!super::is_scribe_error_event("_error"));
        }

        #[test]
        fn extract_error_message_falls_back_to_priority2_when_priority1_message_is_non_string() {
            // priority1 (message) が非文字列なら or_else で priority2 (error string) へ fallback する現契約を固定。
            let value = serde_json::json!({ "message": null, "error": "fallback string" });
            assert_eq!(
                super::extract_error_message(&value),
                Some("fallback string".to_string())
            );

            let value = serde_json::json!({ "message": 123, "error": "from-error" });
            assert_eq!(
                super::extract_error_message(&value),
                Some("from-error".to_string())
            );

            let value = serde_json::json!({ "message": [], "error": "array-message-skip" });
            assert_eq!(
                super::extract_error_message(&value),
                Some("array-message-skip".to_string())
            );
        }

        #[test]
        fn extract_error_message_falls_back_to_priority3_when_priority2_error_is_non_string() {
            // priority2 (error) が object/null なら priority3 (error.message) へ fallback する現契約を固定。
            let value = serde_json::json!({ "error": { "message": "deep nested" } });
            assert_eq!(
                super::extract_error_message(&value),
                Some("deep nested".to_string())
            );

            let value = serde_json::json!({
                "message": null,
                "error": { "message": "deep with priority1 null" }
            });
            assert_eq!(
                super::extract_error_message(&value),
                Some("deep with priority1 null".to_string())
            );

            let value = serde_json::json!({ "error": null });
            assert_eq!(super::extract_error_message(&value), None);
        }

        #[test]
        fn extract_error_message_returns_none_when_all_priorities_yield_non_string() {
            // 全 priority が非文字列な 4 シナリオで終端 None 返却を固定。
            let value = serde_json::json!({ "message": null, "error": null });
            assert_eq!(super::extract_error_message(&value), None);

            let value = serde_json::json!({ "message": [], "error": {} });
            assert_eq!(super::extract_error_message(&value), None);

            let value = serde_json::json!({ "error": { "message": null } });
            assert_eq!(super::extract_error_message(&value), None);

            let value = serde_json::json!({ "message": 1.5, "error": [1, 2], "extra": "noise" });
            assert_eq!(super::extract_error_message(&value), None);
        }

        #[test]
        fn extract_transcript_falls_back_to_text_when_transcript_is_non_string() {
            // ケース 1: transcript=null, text="fallback" → text を採用
            let value = serde_json::json!({ "transcript": null, "text": "fallback" });
            assert_eq!(
                super::extract_transcript(&value),
                Some("fallback".to_string()),
                "transcript=null は as_str() で None、text へ or_else fallback するはず"
            );

            // ケース 2: transcript=number, text="from text"
            let value = serde_json::json!({ "transcript": 42, "text": "from text" });
            assert_eq!(
                super::extract_transcript(&value),
                Some("from text".to_string()),
                "transcript=number は as_str() で None、text へ or_else fallback するはず"
            );

            // ケース 3: transcript=array, text="x"
            let value = serde_json::json!({ "transcript": ["a", "b"], "text": "x" });
            assert_eq!(
                super::extract_transcript(&value),
                Some("x".to_string()),
                "transcript=array は as_str() で None、text へ or_else fallback するはず"
            );
        }

        #[test]
        fn extract_transcript_falls_back_to_words_when_transcript_and_text_are_non_string() {
            // ケース 1: transcript=null, text=null, words=[{"text":"a"},{"word":"b"}] → "ab"
            let value = serde_json::json!({
                "transcript": null,
                "text": null,
                "words": [{ "text": "a" }, { "word": "b" }]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("ab".to_string()),
                "transcript/text 両方 null なら words array へ fallback、text/word 両方拾うはず"
            );

            // ケース 2: transcript=number, text=array, words=[{"text":"x"}] → "x"
            let value = serde_json::json!({
                "transcript": 42,
                "text": ["nested", "array"],
                "words": [{ "text": "x" }]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("x".to_string()),
                "transcript=number と text=array で 2 段抜けて words へ fallback するはず"
            );

            // ケース 3: transcript field 無し、text=number, words=[] → Some("") (空 array でも Some)
            let value = serde_json::json!({ "text": 99, "words": [] });
            assert_eq!(
                super::extract_transcript(&value),
                Some("".to_string()),
                "text=number で 1 段抜け、words=[] でも array なので Some(\"\") のはず"
            );
        }

        #[test]
        fn extract_transcript_returns_none_when_words_field_is_non_array() {
            // ケース 1: words=null
            let value = serde_json::json!({ "words": null });
            assert_eq!(
                super::extract_transcript(&value),
                None,
                "words=null は as_array() で None、最終的に None のはず"
            );

            // ケース 2: words=number
            let value = serde_json::json!({ "words": 42 });
            assert_eq!(
                super::extract_transcript(&value),
                None,
                "words=number は as_array() で None のはず"
            );

            // ケース 3: words=string
            let value = serde_json::json!({ "words": "not-an-array" });
            assert_eq!(
                super::extract_transcript(&value),
                None,
                "words=string は as_array() で None のはず"
            );

            // ケース 4: words=object
            let value = serde_json::json!({ "words": { "text": "still-not-array" } });
            assert_eq!(
                super::extract_transcript(&value),
                None,
                "words=object は as_array() で None のはず (top-level の text 探索とは独立)"
            );
        }

        #[test]
        fn extract_transcript_does_not_fall_back_within_word_entry_when_text_is_non_string() {
            // ケース 1: words=[{"text":null,"word":"actual"}] → Some("")
            // text=null は Some(Value::Null) なので or_else が動かず、as_str() で None、skip される現契約
            let value = serde_json::json!({
                "words": [{ "text": null, "word": "actual" }]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("".to_string()),
                "text=null は or_else が動かず (Some(Null) だから)、as_str() で None、skip され Some(\"\") になる現契約のはず"
            );

            // ケース 2: words=[{"text":42,"word":"y"}] → Some("")
            let value = serde_json::json!({
                "words": [{ "text": 42, "word": "y" }]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("".to_string()),
                "text=number でも or_else 動かず、word fallback されない現契約"
            );

            // ケース 3: text field absent、word="z" → Some("z") (or_else が初めて動く)
            let value = serde_json::json!({
                "words": [{ "word": "z" }]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("z".to_string()),
                "text field 自体無しなら or_else で word が採用される (text=non-string とは違う経路)"
            );
        }

        #[test]
        fn extract_transcript_joins_only_string_entries_in_mixed_words_array_in_order() {
            // ケース 1: 適合 (text=str, word=str) と非適合 (unrelated, text=null+word=null) が混在
            let value = serde_json::json!({
                "words": [
                    { "text": "a" },
                    { "unrelated": "skip" },
                    { "text": null, "word": null },
                    { "word": "c" }
                ]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("ac".to_string()),
                "適合 entry のみ順序保ったまま join、非適合は skip されるはず"
            );

            // ケース 2: 全 entry が non-string field のみ → Some("") (空 join)
            let value = serde_json::json!({
                "words": [
                    { "text": 42 },
                    { "word": 99 },
                    { "text": null, "word": null }
                ]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("".to_string()),
                "全 entry が非適合なら空文字 Some(\"\") を返すはず (None ではない)"
            );

            // ケース 3: 順序保証 regression sanity check (text を 3 つ並べる)
            let value = serde_json::json!({
                "words": [{ "text": "x" }, { "text": "y" }, { "text": "z" }]
            });
            assert_eq!(
                super::extract_transcript(&value),
                Some("xyz".to_string()),
                "filter_map と join の順序が保たれるはず"
            );
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
