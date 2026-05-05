use std::sync::Arc;

use rubato::{Resampler, SincFixedIn};
use whisper_rs::WhisperContext;

use crate::audio_utils::{
    is_tail_silent, sinc_params, MIN_FLUSH_SAMPLES, RESAMPLE_CHUNK_SIZE, SILENCE_LOOKBACK_SAMPLES,
    SILENCE_THRESHOLD_RMS, WHISPER_SAMPLE_RATE,
};
use crate::transcription_traits::{StreamConfig, TranscriptionStream};
use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};
use crate::transcription_whisper_local::WhisperLocal;

// ─────────────────────────────────────────────
// 文字起こしループ
// ─────────────────────────────────────────────

/// チャンクの蓄積目標（秒）
pub(crate) const CHUNK_DURATION_SECS: f64 = 5.0;

/// 16kHz での5秒分のサンプル数
pub(crate) const CHUNK_SAMPLES: usize = (WHISPER_SAMPLE_RATE as f64 * CHUNK_DURATION_SECS) as usize; // 80,000

/// Whisper 用のストリーミング実装。
///
/// 内部で次の処理を行う:
/// - 入力サンプルを 16kHz にリサンプル
/// - 5 秒分たまったら推論を実行
/// - 結果セグメントにストリーム基準のグローバルオフセットを付与
///
/// `drain_segments` は確定済みセグメントを取り出す。
pub struct WhisperStream {
    #[cfg(not(test))]
    pub(crate) ctx: Arc<WhisperContext>,
    #[cfg(test)]
    pub(crate) ctx: Option<Arc<WhisperContext>>,
    pub(crate) speaker: Option<String>,
    pub(crate) source: Option<TranscriptionSource>,
    pub(crate) language: String,
    pub(crate) needs_resample: bool,
    pub(crate) resampler: Option<SincFixedIn<f32>>,
    pub(crate) resample_input_buffer: Vec<f32>,
    pub(crate) accumulation_buffer: Vec<f32>,
    pub(crate) pending_segments: Vec<TranscriptionSegment>,
    pub(crate) chunk_count: u64,
}

impl WhisperStream {
    pub(crate) fn new(ctx: Arc<WhisperContext>, config: StreamConfig) -> Result<Self, String> {
        let needs_resample = config.sample_rate != WHISPER_SAMPLE_RATE;
        let resampler = if needs_resample {
            Some(
                SincFixedIn::<f32>::new(
                    WHISPER_SAMPLE_RATE as f64 / config.sample_rate as f64,
                    2.0,
                    sinc_params(),
                    RESAMPLE_CHUNK_SIZE,
                    1, // モノラル
                )
                .map_err(|e| format!("リサンプラーの作成に失敗しました: {e}"))?,
            )
        } else {
            None
        };

        let language = config.language.unwrap_or_else(|| "auto".to_string());

        Ok(Self {
            #[cfg(not(test))]
            ctx,
            #[cfg(test)]
            ctx: Some(ctx),
            speaker: config.speaker,
            source: config.source,
            language,
            needs_resample,
            resampler,
            resample_input_buffer: Vec::with_capacity(RESAMPLE_CHUNK_SIZE * 2),
            accumulation_buffer: Vec::with_capacity(CHUNK_SAMPLES * 2),
            pending_segments: Vec::new(),
            chunk_count: 0,
        })
    }

    /// 5 秒チャンクが溜まっていれば推論し、`pending_segments` に積む。
    /// 5 秒未満でも最小チャンク長以上かつ末尾が沈黙の場合は早期 flush する。
    fn flush_full_chunks(&mut self) -> Result<(), String> {
        // (a) 5 秒以上たまったら従来通り 5 秒で flush (現状維持、回帰なし)
        while self.accumulation_buffer.len() >= CHUNK_SAMPLES {
            let chunk: Vec<f32> = self.accumulation_buffer.drain(..CHUNK_SAMPLES).collect();
            self.run_inference(&chunk)?;
        }
        // (b) 5 秒未満でも、最小チャンク長以上 + 末尾が沈黙なら早期 flush
        if self.accumulation_buffer.len() >= MIN_FLUSH_SAMPLES
            && is_tail_silent(
                &self.accumulation_buffer,
                SILENCE_LOOKBACK_SAMPLES,
                SILENCE_THRESHOLD_RMS,
            )
        {
            let chunk: Vec<f32> = std::mem::take(&mut self.accumulation_buffer);
            self.run_inference(&chunk)?;
        }
        Ok(())
    }

    fn run_inference(&mut self, chunk: &[f32]) -> Result<(), String> {
        self.chunk_count += 1;
        #[cfg(not(test))]
        let segments = WhisperLocal::transcribe_chunk(&self.ctx, chunk, &self.language)?;
        #[cfg(test)]
        let segments = {
            let ctx = self.ctx.as_ref().ok_or_else(|| {
                "WhisperContext がテストストリームに設定されていません".to_string()
            })?;
            WhisperLocal::transcribe_chunk(ctx, chunk, &self.language)?
        };
        let offset_ms = (self.chunk_count - 1) as i64 * (CHUNK_DURATION_SECS * 1000.0) as i64;
        for seg in segments {
            if seg.text.is_empty() {
                continue;
            }
            self.pending_segments.push(TranscriptionSegment {
                text: seg.text,
                start_ms: seg.start_ms + offset_ms,
                end_ms: seg.end_ms + offset_ms,
                source: self.source,
                speaker: self.speaker.clone(),
                is_error: None,
            });
        }
        Ok(())
    }
}

impl TranscriptionStream for WhisperStream {
    fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }

        if self.needs_resample {
            self.resample_input_buffer.extend_from_slice(samples);

            // resampler は所有権を一時的に取り出して借用問題を回避する
            let mut resampler = self.resampler.take().ok_or_else(|| {
                "リサンプラー状態が利用できません: リサンプリングが必要ですが内部状態がありません"
                    .to_string()
            })?;
            let result = (|| -> Result<(), String> {
                let chunk_size = resampler.input_frames_next();
                while self.resample_input_buffer.len() >= chunk_size {
                    let input_chunk: Vec<f32> =
                        self.resample_input_buffer.drain(..chunk_size).collect();
                    let input_refs: Vec<&[f32]> = vec![&input_chunk];
                    match resampler.process(&input_refs, None) {
                        Ok(output) => {
                            if let Some(channel) = output.first() {
                                self.accumulation_buffer.extend_from_slice(channel);
                            }
                        }
                        Err(e) => return Err(format!("リサンプリングエラー: {e}")),
                    }
                }
                Ok(())
            })();
            self.resampler = Some(resampler);
            result?;
        } else {
            self.accumulation_buffer.extend_from_slice(samples);
        }

        self.flush_full_chunks()
    }

    fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
        std::mem::take(&mut self.pending_segments)
    }

    fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
        // 残ったリサンプリング入力はゼロパディングして処理し切る
        if self.needs_resample && !self.resample_input_buffer.is_empty() {
            let mut resampler = self.resampler.take().ok_or_else(|| {
                "リサンプラー状態が利用できません: リサンプリングが必要ですが内部状態がありません"
                    .to_string()
            })?;
            let chunk_size = resampler.input_frames_next();
            let mut input_chunk = std::mem::take(&mut self.resample_input_buffer);
            input_chunk.resize(chunk_size, 0.0);
            let input_refs: Vec<&[f32]> = vec![&input_chunk];
            match resampler.process(&input_refs, None) {
                Ok(output) => {
                    if let Some(channel) = output.first() {
                        self.accumulation_buffer.extend_from_slice(channel);
                    }
                }
                Err(e) => return Err(format!("リサンプリングエラー: {e}")),
            }
        }

        // 5 秒未満の最終チャンクも推論する
        if !self.accumulation_buffer.is_empty() {
            let chunk = std::mem::take(&mut self.accumulation_buffer);
            self.run_inference(&chunk)?;
        }

        Ok(std::mem::take(&mut self.pending_segments))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription_traits::TranscriptionStream;

    fn stream_with_missing_resampler(resample_input_buffer: Vec<f32>) -> WhisperStream {
        WhisperStream {
            ctx: None,
            speaker: None,
            source: None,
            language: "ja".to_string(),
            needs_resample: true,
            resampler: None,
            resample_input_buffer,
            accumulation_buffer: Vec::new(),
            pending_segments: Vec::new(),
            chunk_count: 0,
        }
    }

    #[test]
    fn test_whisper_stream_feed_errors_when_resampler_state_missing() {
        let mut stream = stream_with_missing_resampler(Vec::new());
        let err = stream.feed(&[0.0]).unwrap_err();
        assert!(err.contains("リサンプラー状態が利用できません"));
    }

    #[test]
    fn test_whisper_stream_finalize_errors_when_resampler_state_missing() {
        let stream = stream_with_missing_resampler(vec![0.0]);
        let err = Box::new(stream).finalize().unwrap_err();
        assert!(err.contains("リサンプラー状態が利用できません"));
    }
}
