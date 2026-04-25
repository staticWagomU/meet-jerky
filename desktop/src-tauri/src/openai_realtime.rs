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

use crate::secret_store::{get_secret, SecretKey};
use crate::transcription::{
    StreamConfig, TranscriptionEngine, TranscriptionSegment, TranscriptionStream,
};

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
        let api_key = get_secret(SecretKey::OpenAIApiKey)?
            .ok_or_else(|| {
                "OpenAI API キーが設定されていません。設定画面から登録してください。"
                    .to_string()
            })?;

        let stream = OpenAIRealtimeStream::new(self.model.clone(), api_key, config)?;
        Ok(Box::new(stream))
    }
}

// ─────────────────────────────────────────────
// OpenAIRealtimeStream
// ─────────────────────────────────────────────

const REALTIME_SAMPLE_RATE: u32 = 24_000;

pub struct OpenAIRealtimeStream {
    audio_tx: tokio::sync::mpsc::UnboundedSender<AudioCommand>,
    pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: Option<String>,
    /// `tauri::async_runtime::spawn` の戻り値。Drop 時にキャンセルする。
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Debug)]
enum AudioCommand {
    Samples(Vec<f32>),
    /// 入力終了を示す。WS タスクは flush してから WS をクローズする。
    Finalize,
}

impl OpenAIRealtimeStream {
    pub fn new(
        model: String,
        api_key: String,
        config: StreamConfig,
    ) -> Result<Self, String> {
        let pending = Arc::new(Mutex::new(Vec::<TranscriptionSegment>::new()));
        let (audio_tx, audio_rx) =
            tokio::sync::mpsc::unbounded_channel::<AudioCommand>();

        let pending_for_task = Arc::clone(&pending);
        let speaker = config.speaker.clone();
        let language = config.language.clone();
        let sample_rate = config.sample_rate;

        let task_handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = ws_task::run(
                api_key,
                model,
                language,
                sample_rate,
                audio_rx,
                pending_for_task.clone(),
                speaker.clone(),
            )
            .await
            {
                // タスク内で発生した致命的エラーをユーザーにも分かるように
                // pending キューに 1 件だけ詰める (segment text に流す簡易方式)。
                let mut q = pending_for_task.lock();
                q.push(TranscriptionSegment {
                    text: format!("[OpenAI Realtime エラー: {e}]"),
                    start_ms: 0,
                    end_ms: 0,
                    speaker: speaker.clone(),
                });
            }
        });

        Ok(Self {
            audio_tx,
            pending,
            speaker: config.speaker,
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
            .map_err(|_| {
                "OpenAI Realtime ストリームが既に停止しています".to_string()
            })?;
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

// ─────────────────────────────────────────────
// WebSocket タスク
// ─────────────────────────────────────────────

mod ws_task {
    use std::sync::Arc;

    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use parking_lot::Mutex;
    use rubato::{Resampler, SincFixedIn};
    use serde_json::json;
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

    use crate::transcription::TranscriptionSegment;

    use super::{AudioCommand, REALTIME_SAMPLE_RATE};

    pub async fn run(
        api_key: String,
        model: String,
        language: Option<String>,
        sample_rate: u32,
        mut audio_rx: UnboundedReceiver<AudioCommand>,
        pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
        speaker: Option<String>,
    ) -> Result<(), String> {
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
        let (mut ws_tx, mut ws_rx) = ws_stream.split();

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
        let reader_task = tokio::spawn(async move {
            while let Some(msg) = ws_rx.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        push_error(&pending_for_reader, &speaker_for_reader, e.to_string());
                        break;
                    }
                };
                match msg {
                    Message::Text(text) => {
                        handle_event(&text, &pending_for_reader, &speaker_for_reader);
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        // ─── 5. 送信ループ: feed されたサンプルを resample/PCM16/base64/送信 ───
        let mut finalized = false;
        while let Some(cmd) = audio_rx.recv().await {
            match cmd {
                AudioCommand::Samples(samples) => {
                    let resampled =
                        resample_block(&mut resampler, &mut resample_buf, &samples)?;
                    if resampled.is_empty() {
                        continue;
                    }
                    let pcm16 = float_to_pcm16(&resampled);
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&pcm16);
                    let event =
                        json!({ "type": "input_audio_buffer.append", "audio": b64 });
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

        // 受信タスクを少しだけ待つ (確定イベントの取りこぼしを抑える)。
        // タイムアウトを設けて永久ブロックを避ける。
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), reader_task).await;

        Ok(())
    }

    fn handle_event(
        text: &str,
        pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
        speaker: &Option<String>,
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
            if let Some(transcript) =
                value.get("transcript").and_then(|v| v.as_str())
            {
                let trimmed = transcript.trim();
                if !trimmed.is_empty() {
                    pending.lock().push(TranscriptionSegment {
                        text: trimmed.to_string(),
                        start_ms: 0,
                        end_ms: 0,
                        speaker: speaker.clone(),
                    });
                }
            }
        } else if event_type == "error" {
            if let Some(message) = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
            {
                push_error(pending, speaker, message.to_string());
            }
        }
    }

    fn push_error(
        pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
        speaker: &Option<String>,
        message: String,
    ) {
        pending.lock().push(TranscriptionSegment {
            text: format!("[OpenAI Realtime エラー: {message}]"),
            start_ms: 0,
            end_ms: 0,
            speaker: speaker.clone(),
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
    fn float_to_pcm16_handles_full_range_and_clamping() {
        // 0 / +1 / -1 / クリップ範囲外を PCM16 LE に変換する。
        // OpenAI Realtime API が要求する PCM16 little-endian の境界値を固定化する。
        let samples = [0.0_f32, 1.0, -1.0, 1.5, -1.5];
        let bytes = ws_task::float_to_pcm16(&samples);
        assert_eq!(bytes.len(), samples.len() * 2);

        let read = |i: usize| -> i16 {
            i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]])
        };
        assert_eq!(read(0), 0);
        assert_eq!(read(1), i16::MAX);
        // -1.0 → -32767 (round). MIN (-32768) ではないことに注意。
        assert_eq!(read(2), -i16::MAX);
        // クリップされる値は端 (i16::MAX / -i16::MAX) になる。
        assert_eq!(read(3), i16::MAX);
        assert_eq!(read(4), -i16::MAX);
    }

    #[test]
    fn float_to_pcm16_empty_input_yields_empty_output() {
        assert!(ws_task::float_to_pcm16(&[]).is_empty());
    }

    #[test]
    fn engine_construction_records_model() {
        let engine = OpenAIRealtimeEngine::new("gpt-4o-mini-transcribe");
        assert_eq!(engine.model, "gpt-4o-mini-transcribe");
    }
}
