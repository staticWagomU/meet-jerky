pub(crate) const TRANSCRIPTION_ERROR_EVENT: &str = "transcription-error";
pub(crate) const TRANSCRIPTION_RESULT_EVENT: &str = "transcription-result";
pub(crate) const LIVE_CAPTION_RESET_EVENT: &str = "live-caption-reset";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_event_names_match_frontend_contract() {
        assert_eq!(TRANSCRIPTION_ERROR_EVENT, "transcription-error");
        assert_eq!(TRANSCRIPTION_RESULT_EVENT, "transcription-result");
        assert_eq!(LIVE_CAPTION_RESET_EVENT, "live-caption-reset");
    }
}
