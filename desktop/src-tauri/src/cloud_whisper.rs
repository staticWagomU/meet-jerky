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

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub struct WhisperRequestParams {
    pub model: String,
    pub language: Option<String>,
    pub response_format: String,
    pub temperature: f32,
}

#[allow(dead_code)]
pub fn build_whisper_request_params(
    model: &str,
    language: Option<&str>,
) -> Result<WhisperRequestParams, String> {
    if model.is_empty() {
        return Err("model must not be empty".to_string());
    }
    Ok(WhisperRequestParams {
        model: model.to_string(),
        language: language.map(|s| s.to_string()),
        response_format: "verbose_json".to_string(),
        temperature: 0.0,
    })
}

#[derive(Clone, PartialEq)]
#[allow(dead_code)]
pub struct WhisperHttpRequestDescriptor {
    pub url: String,
    pub auth_header: String,
    pub params: WhisperRequestParams,
}

impl std::fmt::Debug for WhisperHttpRequestDescriptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WhisperHttpRequestDescriptor")
            .field("url", &self.url)
            .field("auth_header", &"<redacted>")
            .field("params", &self.params)
            .finish()
    }
}

#[allow(dead_code)]
pub fn build_whisper_http_request_descriptor(
    base_url: &str,
    api_key: &str,
    model: &str,
    language: Option<&str>,
) -> Result<WhisperHttpRequestDescriptor, String> {
    let url = build_whisper_api_url(base_url);
    let auth_header = build_whisper_authorization_header(api_key);
    let params = build_whisper_request_params(model, language)?;
    Ok(WhisperHttpRequestDescriptor {
        url,
        auth_header,
        params,
    })
}

#[allow(dead_code)]
pub fn build_whisper_multipart_text_fields(
    descriptor: &WhisperHttpRequestDescriptor,
) -> Vec<(&'static str, String)> {
    let mut fields: Vec<(&'static str, String)> = vec![
        ("model", descriptor.params.model.clone()),
        ("response_format", "verbose_json".to_string()),
        ("temperature", "0".to_string()),
    ];
    if let Some(lang) = &descriptor.params.language {
        fields.push(("language", lang.clone()));
    }
    fields
}

#[allow(dead_code)]
pub fn parse_whisper_verbose_response(body: &str) -> Result<Vec<TranscriptionSegment>, String> {
    let response: VerboseResponse =
        serde_json::from_str(body).map_err(|e| format!("cloud whisper parse error: {e}"))?;

    Ok(response
        .segments
        .into_iter()
        .map(|seg| TranscriptionSegment {
            text: seg.text.trim().to_string(),
            start_ms: (seg.start * 1000.0).round() as i64,
            end_ms: (seg.end * 1000.0).round() as i64,
            source: None,
            speaker: None,
            is_error: None,
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

    #[test]
    fn build_whisper_request_params_with_ja_language() {
        let params = build_whisper_request_params("small", Some("ja")).expect("should build");

        assert_eq!(
            params,
            WhisperRequestParams {
                model: "small".to_string(),
                language: Some("ja".to_string()),
                response_format: "verbose_json".to_string(),
                temperature: 0.0,
            }
        );
    }

    #[test]
    fn build_whisper_request_params_with_en_language_tiny_model() {
        let params = build_whisper_request_params("tiny", Some("en")).expect("should build");

        assert_eq!(
            params,
            WhisperRequestParams {
                model: "tiny".to_string(),
                language: Some("en".to_string()),
                response_format: "verbose_json".to_string(),
                temperature: 0.0,
            }
        );
    }

    #[test]
    fn build_whisper_request_params_rejects_empty_model() {
        let result = build_whisper_request_params("", Some("ja"));

        assert!(result.is_err(), "expected Err for empty model");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("model"),
            "error message should mention 'model', got: {msg}"
        );
    }

    #[test]
    fn build_descriptor_propagates_empty_model_error() {
        let result = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1",
            "sk-x",
            "",
            Some("ja"),
        );

        assert!(result.is_err(), "expected Err for empty model");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("model"),
            "error message should mention 'model', got: {msg}"
        );
    }

    #[test]
    fn build_descriptor_with_tiny_model_and_trailing_slash_base_url() {
        let descriptor = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1/",
            "sk-other",
            "tiny",
            None,
        )
        .expect("should build descriptor");

        assert_eq!(
            descriptor,
            WhisperHttpRequestDescriptor {
                url: "https://api.openai.com/v1/audio/transcriptions".to_string(),
                auth_header: "Bearer sk-other".to_string(),
                params: WhisperRequestParams {
                    model: "tiny".to_string(),
                    language: None,
                    response_format: "verbose_json".to_string(),
                    temperature: 0.0,
                },
            }
        );
    }

    #[test]
    fn build_multipart_text_fields_with_small_model_and_ja_language() {
        let descriptor = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1",
            "sk-x",
            "small",
            Some("ja"),
        )
        .expect("should build descriptor");

        let fields = build_whisper_multipart_text_fields(&descriptor);

        assert_eq!(
            fields,
            vec![
                ("model", "small".to_string()),
                ("response_format", "verbose_json".to_string()),
                ("temperature", "0".to_string()),
                ("language", "ja".to_string()),
            ]
        );
    }

    #[test]
    fn build_multipart_text_fields_with_tiny_model_and_en_language() {
        let descriptor = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1",
            "sk-x",
            "tiny",
            Some("en"),
        )
        .expect("should build descriptor");

        let fields = build_whisper_multipart_text_fields(&descriptor);

        assert_eq!(
            fields,
            vec![
                ("model", "tiny".to_string()),
                ("response_format", "verbose_json".to_string()),
                ("temperature", "0".to_string()),
                ("language", "en".to_string()),
            ]
        );
    }

    #[test]
    fn build_multipart_text_fields_omits_language_when_none() {
        let descriptor = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1/",
            "sk-x",
            "tiny",
            None,
        )
        .expect("should build descriptor");

        let fields = build_whisper_multipart_text_fields(&descriptor);

        assert_eq!(
            fields,
            vec![
                ("model", "tiny".to_string()),
                ("response_format", "verbose_json".to_string()),
                ("temperature", "0".to_string()),
            ]
        );
    }

    #[test]
    fn build_descriptor_with_ja_language() {
        let descriptor = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1",
            "sk-test-abc",
            "small",
            Some("ja"),
        )
        .expect("should build descriptor");

        assert_eq!(
            descriptor,
            WhisperHttpRequestDescriptor {
                url: "https://api.openai.com/v1/audio/transcriptions".to_string(),
                auth_header: "Bearer sk-test-abc".to_string(),
                params: WhisperRequestParams {
                    model: "small".to_string(),
                    language: Some("ja".to_string()),
                    response_format: "verbose_json".to_string(),
                    temperature: 0.0,
                },
            }
        );
    }

    #[test]
    fn descriptor_debug_redacts_authorization_header() {
        let descriptor = build_whisper_http_request_descriptor(
            "https://api.openai.com/v1",
            "sk-test-abc",
            "small",
            Some("ja"),
        )
        .expect("should build descriptor");

        let debug = format!("{descriptor:?}");

        assert!(debug.contains("auth_header"));
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("sk-test-abc"));
        assert!(!debug.contains("Bearer sk-test-abc"));
    }

    #[test]
    fn parse_whisper_verbose_response_handles_single_segment_with_all_default_fields_none() {
        let body =
            r#"{"segments": [{"id": 0, "seek": 0, "start": 1.5, "end": 3.0, "text": "single"}]}"#;

        let segments = parse_whisper_verbose_response(body).expect("should parse");

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "single");
        assert_eq!(segments[0].start_ms, 1500);
        assert_eq!(segments[0].end_ms, 3000);
        assert!(segments[0].source.is_none());
        assert!(segments[0].speaker.is_none());
        assert!(segments[0].is_error.is_none());
    }

    #[test]
    fn parse_whisper_verbose_response_rounds_fractional_milliseconds_to_nearest() {
        let body = r#"{
            "segments": [
                {"id": 0, "seek": 0, "start": 0.0001, "end": 0.4999, "text": "a"},
                {"id": 1, "seek": 0, "start": 0.5001, "end": 0.9999, "text": "b"},
                {"id": 2, "seek": 0, "start": 0.5, "end": 1.0, "text": "c"}
            ]
        }"#;

        let segments = parse_whisper_verbose_response(body).expect("should parse");

        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 500);
        assert_eq!(segments[1].start_ms, 500);
        assert_eq!(segments[1].end_ms, 1000);
        assert_eq!(segments[2].start_ms, 500);
        assert_eq!(segments[2].end_ms, 1000);
    }

    #[test]
    fn parse_whisper_verbose_response_trims_text_edges_only_preserves_internal_whitespace() {
        let body = r#"{
            "segments": [
                {"id": 0, "seek": 0, "start": 0.0, "end": 1.0, "text": "  hello world  "},
                {"id": 1, "seek": 0, "start": 1.0, "end": 2.0, "text": "  日本語  テキスト  "}
            ]
        }"#;

        let segments = parse_whisper_verbose_response(body).expect("should parse");

        assert_eq!(segments[0].text, "hello world");
        assert_eq!(segments[1].text, "日本語  テキスト");
    }

    #[test]
    fn parse_whisper_verbose_response_returns_err_when_segments_field_missing() {
        let body = r#"{"task": "transcribe", "language": "ja"}"#;

        let result = parse_whisper_verbose_response(body);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .starts_with("cloud whisper parse error:"));
    }

    #[test]
    fn parse_whisper_verbose_response_preserves_reverse_ordered_timestamps_without_validation() {
        let body =
            r#"{"segments": [{"id": 0, "seek": 0, "start": 5.0, "end": 2.0, "text": "reversed"}]}"#;

        let result = parse_whisper_verbose_response(body);

        assert!(result.is_ok());
        let segments = result.unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 5000);
        assert_eq!(segments[0].end_ms, 2000);
    }
}
