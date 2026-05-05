//! ElevenLabs Scribe v2 Realtime API の WebSocket タスク実装。
//!
//! `elevenlabs_realtime.rs` から `mod ws_task` を切り出し、WebSocket I/O 詳細
//! (接続 + base64 PCM16 送信 + commit + handle_event) を集約する。
//! caller は `elevenlabs_realtime.rs` の `ElevenLabsRealtimeStream::new` 内 spawn のみ。

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rubato::SincFixedIn;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::realtime_audio_command::AudioCommand;
use crate::realtime_audio_helpers::{float_to_pcm16, resample_block};
use crate::realtime_ws_helpers::{
    extract_error_message, extract_transcript, is_scribe_error_event, wait_for_pending_after_commit,
};
use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

const ELEVENLABS_REALTIME_SAMPLE_RATE: u32 = 16_000;

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
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
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
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
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
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
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
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
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
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
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
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
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
