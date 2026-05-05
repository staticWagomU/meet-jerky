use std::sync::Arc;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};
use crate::transcription_types::TranscriptionSegment;
use crate::transcription_whisper_stream::WhisperStream;

// ─────────────────────────────────────────────
// WhisperLocal 実装
// ─────────────────────────────────────────────

pub struct WhisperLocal {
    ctx: Arc<WhisperContext>,
}

impl WhisperLocal {
    pub fn new(model_path: &str) -> Result<Self, String> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| format!("Whisper モデルの読み込みに失敗しました: {e}"))?;
        Ok(Self { ctx: Arc::new(ctx) })
    }

    /// 1 チャンク (16kHz, モノラル) を Whisper で推論する。
    pub(crate) fn transcribe_chunk(
        ctx: &WhisperContext,
        audio: &[f32],
        language: &str,
    ) -> Result<Vec<TranscriptionSegment>, String> {
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("WhisperState の作成に失敗しました: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_no_context(true);

        state
            .full(params, audio)
            .map_err(|e| format!("Whisper 推論に失敗しました: {e}"))?;

        let num_segments = state.full_n_segments();
        let mut segments = Vec::with_capacity(num_segments as usize);

        for i in 0..num_segments {
            let segment = match state.get_segment(i) {
                Some(seg) => seg,
                None => continue,
            };

            let text = segment
                .to_str_lossy()
                .map_err(|e| format!("セグメントテキストの取得に失敗しました: {e}"))?
                .trim()
                .to_string();

            let start_ts = segment.start_timestamp();
            let end_ts = segment.end_timestamp();

            // whisper のタイムスタンプは centiseconds（10ms 単位）
            segments.push(TranscriptionSegment {
                text,
                start_ms: start_ts * 10,
                end_ms: end_ts * 10,
                source: None,
                speaker: None,
                is_error: None,
            });
        }

        Ok(segments)
    }
}

impl TranscriptionEngine for WhisperLocal {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String> {
        let stream = WhisperStream::new(Arc::clone(&self.ctx), config)?;
        Ok(Box::new(stream))
    }
}
