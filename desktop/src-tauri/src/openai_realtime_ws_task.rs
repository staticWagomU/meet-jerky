//! OpenAI Realtime API の WebSocket タスク実装。
//!
//! `openai_realtime.rs` から `mod ws_task` を切り出し、WebSocket I/O 詳細
//! (接続 + session.update + リサンプリング + 送受信ループ + handle_event) を集約する。
//! caller は `openai_realtime.rs` の `OpenAIRealtimeStream::new` 内 spawn のみ。

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rubato::SincFixedIn;
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::realtime_audio_command::AudioCommand;
use crate::realtime_audio_helpers::{float_to_pcm16, resample_block};
use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

const REALTIME_SAMPLE_RATE: u32 = 24_000;

const READER_FINALIZE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct RunParams {
    pub api_key: String,
    pub model: String,
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
        model,
        language,
        sample_rate,
        mut audio_rx,
        pending,
        speaker,
        source,
    } = params;
    // ─── 1. WebSocket 接続 ───
    let url = "wss://api.openai.com/v1/realtime?intent=transcription";
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("WebSocket リクエスト構築に失敗: {e}"))?;
    let headers = request.headers_mut();
    headers.insert(
        "Authorization",
        format!("Bearer {api_key}")
            .parse()
            .map_err(|e| format!("Authorization ヘッダの構築に失敗: {e}"))?,
    );
    // API_VERIFY: ベータヘッダ名。現状は `OpenAI-Beta: realtime=v1`。
    headers.insert(
        "OpenAI-Beta",
        "realtime=v1"
            .parse()
            .map_err(|e| format!("OpenAI-Beta ヘッダの構築に失敗: {e}"))?,
    );

    let (ws_stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WebSocket 接続に失敗しました: {e}"))?;
    let (mut ws_tx, ws_rx) = ws_stream.split();

    // ─── 2. session.update でフォーマット指定 ───
    let lang = language.as_deref().unwrap_or("auto");
    let language_field = if lang == "auto" {
        // API_VERIFY: language 省略時の挙動。null で自動検出される想定。
        serde_json::Value::Null
    } else {
        serde_json::Value::String(lang.to_string())
    };

    // API_VERIFY: イベント名 / フィールド構造。OpenAI Realtime ドキュメントの
    // 最新版で確認すること。"transcription_session.update" / "session.update" の
    // どちらかがバージョンによって正しい。
    let session_update = json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm16",
            "input_audio_transcription": {
                "model": model,
                "language": language_field
            }
        }
    });
    ws_tx
        .send(Message::Text(session_update.to_string()))
        .await
        .map_err(|e| format!("session.update 送信に失敗: {e}"))?;

    // ─── 3. リサンプラー準備 (device_rate → 24kHz) ───
    let needs_resample = sample_rate != REALTIME_SAMPLE_RATE;
    let mut resampler = if needs_resample {
        Some(
            SincFixedIn::<f32>::new(
                REALTIME_SAMPLE_RATE as f64 / sample_rate as f64,
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

    // ─── 4. 受信タスクを別 task で起こす ───
    let pending_for_reader = Arc::clone(&pending);
    let speaker_for_reader = speaker.clone();
    let source_for_reader = source;
    let reader_task = tokio::spawn(crate::realtime_reader_task::run_reader_task(
        ws_rx,
        pending_for_reader,
        speaker_for_reader,
        source_for_reader,
        "OpenAI",
        handle_event,
    ));

    // ─── 5. 送信ループ: feed されたサンプルを resample/PCM16/base64/送信 ───
    let mut finalized = false;
    while let Some(cmd) = audio_rx.recv().await {
        match cmd {
            AudioCommand::Samples(samples) => {
                let resampled = resample_block(&mut resampler, &mut resample_buf, &samples)?;
                if resampled.is_empty() {
                    continue;
                }
                let pcm16 = float_to_pcm16(&resampled);
                let b64 = base64::engine::general_purpose::STANDARD.encode(&pcm16);
                let event = json!({ "type": "input_audio_buffer.append", "audio": b64 });
                if let Err(e) = ws_tx.send(Message::Text(event.to_string())).await {
                    return Err(format!("音声送信に失敗: {e}"));
                }
            }
            AudioCommand::Finalize => {
                finalized = true;
                // API_VERIFY: ストリーム終端のシグナル。"input_audio_buffer.commit"
                // で確定 → セッション終了の流れを想定。
                let commit = json!({ "type": "input_audio_buffer.commit" });
                let _ = ws_tx.send(Message::Text(commit.to_string())).await;
                break;
            }
        }
    }

    // ─── 6. 終了処理 ───
    if !finalized {
        // 送信側 channel が drop されたケース。WS をクローズする。
    }
    let _ = ws_tx.send(Message::Close(None)).await;

    // 受信タスクの自然終了 (Message::Close 受信か WS エラー) を最大 10 秒待つ。
    // OpenAI Realtime の最終 transcription_completed 到着を取りこぼさないため。
    let _ = tokio::time::timeout(READER_FINALIZE_TIMEOUT, reader_task).await;

    Ok(())
}

pub(crate) fn handle_event(
    text: &str,
    pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: &Option<String>,
    source: Option<TranscriptionSource>,
) {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let event_type = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    // API_VERIFY: 確定イベント名。delta は部分結果なので無視 (将来 UI に
    // 流すなら別チャネルを設ける)。
    if event_type == "conversation.item.input_audio_transcription.completed" {
        if let Some(transcript) = value.get("transcript").and_then(|v| v.as_str()) {
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
    } else if event_type == "error" {
        if let Some(message) = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            crate::realtime_error_helpers::push_error(
                "OpenAI",
                pending,
                speaker,
                source,
                message.to_string(),
            );
        }
    }
}
