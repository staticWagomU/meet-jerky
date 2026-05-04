use std::sync::Arc;

use tauri::Emitter;

use crate::session_manager::SessionManager;
use crate::transcription_types::TranscriptionSegment;

/// セグメントを Tauri イベントとして emit し、セッションが開始済みであれば
/// `SessionManager` にも append する。
pub(crate) fn emit_segments(
    segments: Vec<TranscriptionSegment>,
    app: &tauri::AppHandle,
    session_manager: &Arc<SessionManager>,
    stream_started_at_secs: u64,
) {
    for segment in segments {
        if segment.text.is_empty() {
            continue;
        }
        let _ = app.emit("transcription-result", &segment);

        let session_started_at_secs = session_manager.current_started_at_secs();
        let observed_at_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs());
        if let Some((sp, off, tx)) = crate::transcript_bridge::build_append_args_for_emission_at(
            &segment,
            session_started_at_secs,
            stream_started_at_secs,
            observed_at_secs,
        ) {
            if let Err(e) = session_manager.append(sp, off, tx) {
                eprintln!("[transcription] session_manager.append failed: {e}");
            }
        }
    }
}
