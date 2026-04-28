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

use crate::secret_store::{get_secret, SecretKey};
use crate::transcription::{
    StreamConfig, TranscriptionEngine, TranscriptionSegment, TranscriptionSource,
    TranscriptionStream,
};

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

#[derive(Debug)]
enum AudioCommand {
    Samples(Vec<f32>),
    Finalize,
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
            if let Err(e) = ws_task::run(
                api_key,
                model_id,
                language,
                sample_rate,
                audio_rx,
                pending_for_task.clone(),
                speaker.clone(),
                source,
            )
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

    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use parking_lot::Mutex;
    use rubato::{Resampler, SincFixedIn};
    use serde_json::{json, Value};
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

    use crate::transcription::{TranscriptionSegment, TranscriptionSource};

    use super::{AudioCommand, ELEVENLABS_REALTIME_SAMPLE_RATE};

    pub async fn run(
        api_key: String,
        model_id: String,
        language: Option<String>,
        sample_rate: u32,
        mut audio_rx: UnboundedReceiver<AudioCommand>,
        pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
        speaker: Option<String>,
        source: Option<TranscriptionSource>,
    ) -> Result<(), String> {
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
                        push_error(
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
            wait_for_pending_after_commit(&pending, pending_len_before_finalize).await;
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
                    push_error(pending, speaker, source, message);
                }
            }
            Some(event_name) if is_scribe_error_event(event_name) => {
                if let Some(message) = extract_error_message(&value) {
                    push_error(pending, speaker, source, message);
                }
            }
            _ => {}
        }
    }

    fn is_scribe_error_event(event_name: &str) -> bool {
        event_name.starts_with("scribe_") && event_name.ends_with("_error")
    }

    async fn wait_for_pending_after_commit(
        pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
        previous_len: usize,
    ) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            if pending.lock().len() > previous_len {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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

    fn push_error(
        pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
        speaker: &Option<String>,
        source: Option<TranscriptionSource>,
        message: String,
    ) {
        pending.lock().push(TranscriptionSegment {
            text: format!("[ElevenLabs Realtime エラー: {message}]"),
            start_ms: 0,
            end_ms: 0,
            source,
            speaker: speaker.clone(),
            is_error: Some(true),
        });
    }

    fn resample_block(
        resampler: &mut Option<SincFixedIn<f32>>,
        buffer: &mut Vec<f32>,
        input: &[f32],
    ) -> Result<Vec<f32>, String> {
        if let Some(resampler) = resampler {
            buffer.extend_from_slice(input);
            let mut out: Vec<f32> = Vec::new();
            let chunk_size = resampler.input_frames_next();
            while buffer.len() >= chunk_size {
                let chunk: Vec<f32> = buffer.drain(..chunk_size).collect();
                let refs: Vec<&[f32]> = vec![&chunk];
                match resampler.process(&refs, None) {
                    Ok(result) => {
                        if let Some(channel) = result.first() {
                            out.extend_from_slice(channel);
                        }
                    }
                    Err(e) => return Err(format!("リサンプリングエラー: {e}")),
                }
            }
            Ok(out)
        } else {
            Ok(input.to_vec())
        }
    }

    pub(crate) fn float_to_pcm16(input: &[f32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len() * 2);
        for &s in input {
            let clamped = s.clamp(-1.0, 1.0);
            let i = (clamped * i16::MAX as f32).round() as i16;
            out.extend_from_slice(&i.to_le_bytes());
        }
        out
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
    fn float_to_pcm16_handles_full_range_and_clamping() {
        let samples = [0.0_f32, 1.0, -1.0, 1.5, -1.5];
        let bytes = ws_task::float_to_pcm16(&samples);
        assert_eq!(bytes.len(), samples.len() * 2);

        let read = |i: usize| -> i16 { i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]) };
        assert_eq!(read(0), 0);
        assert_eq!(read(1), i16::MAX);
        assert_eq!(read(2), -i16::MAX);
        assert_eq!(read(3), i16::MAX);
        assert_eq!(read(4), -i16::MAX);
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
    }
}
