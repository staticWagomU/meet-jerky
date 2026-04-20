use serde::Deserialize;

use crate::transcription::TranscriptionSegment;

#[derive(Debug, Deserialize)]
struct VerboseResponse {
    segments: Vec<VerboseSegment>,
}

#[derive(Debug, Deserialize)]
struct VerboseSegment {
    start: f64,
    end: f64,
    text: String,
}

#[allow(dead_code)]
pub fn build_whisper_api_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    format!("{trimmed}/audio/transcriptions")
}

#[allow(dead_code)]
pub fn build_whisper_authorization_header(api_key: &str) -> String {
    format!("Bearer {api_key}")
}

#[allow(dead_code)]
pub fn parse_whisper_verbose_response(body: &str) -> Result<Vec<TranscriptionSegment>, String> {
    let response: VerboseResponse = serde_json::from_str(body)
        .map_err(|e| format!("cloud whisper parse error: {e}"))?;

    Ok(response
        .segments
        .into_iter()
        .map(|seg| TranscriptionSegment {
            text: seg.text.trim().to_string(),
            start_ms: (seg.start * 1000.0).round() as i64,
            end_ms: (seg.end * 1000.0).round() as i64,
            speaker: None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::TranscriptionSegment;

    #[test]
    fn parses_verbose_response_with_two_segments() {
        let body = r#"{
            "task": "transcribe",
            "language": "japanese",
            "duration": 10.5,
            "text": "こんにちは 世界",
            "segments": [
                {"id": 0, "seek": 0, "start": 0.0, "end": 2.5, "text": "こんにちは"},
                {"id": 1, "seek": 0, "start": 2.5, "end": 5.25, "text": "世界"}
            ]
        }"#;

        let segments: Vec<TranscriptionSegment> =
            parse_whisper_verbose_response(body).expect("should parse");

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "こんにちは");
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 2500);
        assert!(segments[0].speaker.is_none());
        assert_eq!(segments[1].text, "世界");
        assert_eq!(segments[1].start_ms, 2500);
        assert_eq!(segments[1].end_ms, 5250);
        assert!(segments[1].speaker.is_none());
    }

    #[test]
    fn returns_err_on_malformed_json() {
        let body = "not json";

        let result = parse_whisper_verbose_response(body);

        assert!(result.is_err(), "expected Err for malformed JSON");
        let msg = result.unwrap_err();
        assert!(
            msg.starts_with("cloud whisper parse error:"),
            "unexpected error message: {msg}"
        );
    }

    #[test]
    fn returns_ok_with_empty_vec_when_segments_array_is_empty() {
        let body = r#"{"task": "transcribe", "segments": []}"#;

        let segments = parse_whisper_verbose_response(body).expect("should parse");

        assert!(segments.is_empty());
    }

    #[test]
    fn build_whisper_api_url_appends_transcriptions_path() {
        let url = build_whisper_api_url("https://api.openai.com/v1");

        assert_eq!(url, "https://api.openai.com/v1/audio/transcriptions");
    }

    #[test]
    fn build_whisper_api_url_normalizes_trailing_slash() {
        let url = build_whisper_api_url("https://api.openai.com/v1/");

        assert_eq!(url, "https://api.openai.com/v1/audio/transcriptions");
    }

    #[test]
    fn build_whisper_authorization_header_returns_bearer_form() {
        let header = build_whisper_authorization_header("sk-xxx");

        assert_eq!(header, "Bearer sk-xxx");
    }
}
