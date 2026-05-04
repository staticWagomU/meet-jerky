use crate::transcription_types::{TranscriptionErrorPayload, TranscriptionSource};

pub(crate) fn build_transcription_error_payload(
    error: String,
    source: Option<TranscriptionSource>,
) -> TranscriptionErrorPayload {
    TranscriptionErrorPayload { error, source }
}

pub(crate) fn build_worker_panic_error_payload(
    source: Option<TranscriptionSource>,
) -> TranscriptionErrorPayload {
    build_transcription_error_payload("文字起こしワーカーが異常終了しました".to_string(), source)
}

#[cfg(test)]
pub(crate) fn transcription_error_payload_to_value(
    payload: &TranscriptionErrorPayload,
) -> serde_json::Value {
    serde_json::to_value(payload).expect("transcription error payload should serialize to JSON")
}

pub(crate) fn is_realtime_stream_already_stopped_error(error: &str) -> bool {
    error.contains("Realtime ストリームが既に停止しています")
}

pub(crate) fn should_emit_realtime_stream_error(error: &str) -> bool {
    !is_realtime_stream_already_stopped_error(error)
}
