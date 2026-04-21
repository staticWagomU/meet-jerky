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

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub struct WhisperHttpRequestDescriptor {
    pub url: String,
    pub auth_header: String,
    pub params: WhisperRequestParams,
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

pub fn build_whisper_multipart_text_fields(
    descriptor: &WhisperHttpRequestDescriptor,
) -> Vec<(&'static str, String)> {
    vec![
        ("model", descriptor.params.model.clone()),
        ("response_format", "verbose_json".to_string()),
        ("temperature", "0".to_string()),
        (
            "language",
            descriptor.params.language.clone().unwrap_or_default(),
        ),
    ]
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
}
