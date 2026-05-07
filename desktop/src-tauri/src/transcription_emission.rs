use std::sync::Arc;

use tauri::Emitter;

use crate::session_manager::SessionManager;
use crate::transcription_events::TRANSCRIPTION_RESULT_EVENT;
use crate::transcription_types::TranscriptionSegment;

fn is_transcription_segment_emit_candidate(text: &str) -> bool {
    !text.trim().is_empty()
}

/// セグメントを Tauri イベントとして emit し、セッションが開始済みであれば
/// `SessionManager` にも append する。
pub(crate) fn emit_segments(
    segments: Vec<TranscriptionSegment>,
    app: &tauri::AppHandle,
    session_manager: &Arc<SessionManager>,
    stream_started_at_secs: u64,
) {
    for segment in segments {
        if !is_transcription_segment_emit_candidate(&segment.text) {
            continue;
        }
        let _ = app.emit(TRANSCRIPTION_RESULT_EVENT, &segment);

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

#[cfg(test)]
mod tests {
    use super::is_transcription_segment_emit_candidate;

    #[test]
    fn empty_text_is_not_emit_candidate() {
        assert!(!is_transcription_segment_emit_candidate(""));
    }

    #[test]
    fn ascii_whitespace_only_text_is_not_emit_candidate() {
        assert!(!is_transcription_segment_emit_candidate(" \n\t\r"));
    }

    #[test]
    fn unicode_whitespace_only_text_is_not_emit_candidate() {
        assert!(!is_transcription_segment_emit_candidate("\u{3000}\u{2003}"));
    }

    #[test]
    fn non_empty_text_with_surrounding_whitespace_is_emit_candidate() {
        assert!(is_transcription_segment_emit_candidate(
            " \n\tこんにちは\u{3000}"
        ));
    }
}
