use std::sync::Arc;

use parking_lot::Mutex;

use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

/// Realtime engine 共通: ws_task 内で発生したエラーを segment text に流す。
/// engine_label = "ElevenLabs" / "OpenAI" 等。
pub(crate) fn push_error(
    engine_label: &str,
    pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: &Option<String>,
    source: Option<TranscriptionSource>,
    message: String,
) {
    pending.lock().push(TranscriptionSegment {
        text: format!("[{engine_label} Realtime エラー: {message}]"),
        start_ms: 0,
        end_ms: 0,
        source,
        speaker: speaker.clone(),
        is_error: Some(true),
    });
}
