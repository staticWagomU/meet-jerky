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

    #[test]
    fn build_whisper_api_url_with_empty_base_url_returns_absolute_path() {
        // base_url = "" でも fn は何も検証せず "/audio/transcriptions" を返す現挙動を固定。
        let url = build_whisper_api_url("");

        assert_eq!(url, "/audio/transcriptions");
    }

    #[test]
    fn build_whisper_api_url_with_only_slash_returns_absolute_path() {
        // "/" は trim_end_matches('/') で完全に剥がされ "/audio/transcriptions" になる現挙動を固定。
        let url = build_whisper_api_url("/");

        assert_eq!(url, "/audio/transcriptions");
    }

    #[test]
    fn build_whisper_api_url_strips_multiple_trailing_slashes() {
        // trim_end_matches('/') は連続する '/' をすべて削除する。strip_suffix("/") への誤リファクタを検知。
        let url = build_whisper_api_url("https://api.openai.com/v1///");

        assert_eq!(url, "https://api.openai.com/v1/audio/transcriptions");
    }

    #[test]
    fn build_whisper_authorization_header_with_empty_api_key_yields_bearer_with_trailing_space() {
        // 空 api_key でも fn は validation 無しで "Bearer " を返す現挙動を固定。
        let header = build_whisper_authorization_header("");

        assert_eq!(header, "Bearer ");
    }

    #[test]
    fn build_whisper_authorization_header_does_not_trim_or_validate_input() {
        // ケース 1: 前後 whitespace は trim されず Bearer の後ろにそのまま埋め込まれる現挙動を固定。
        {
            let header = build_whisper_authorization_header(" sk-xxx ");
            assert_eq!(header, "Bearer  sk-xxx ");
        }

        // ケース 2: multibyte api_key は UTF-8 panic を起こさず Bearer の後ろに埋め込まれる現挙動を固定。
        {
            let header = build_whisper_authorization_header("日本語キー");
            assert_eq!(header, "Bearer 日本語キー");
        }
    }

    #[test]
    fn whisper_request_params_debug_output_contains_struct_name_and_all_four_field_names_with_option_variants(
    ) {
        let with_lang = WhisperRequestParams {
            model: "small".to_string(),
            language: Some("ja".to_string()),
            response_format: "verbose_json".to_string(),
            temperature: 0.0,
        };
        let without_lang = WhisperRequestParams {
            model: "large-v3".to_string(),
            language: None,
            response_format: "json".to_string(),
            temperature: 0.5,
        };
        let with_dbg = format!("{with_lang:?}");
        let without_dbg = format!("{without_lang:?}");

        assert!(with_dbg.contains("WhisperRequestParams"));
        assert!(with_dbg.contains("model"));
        assert!(with_dbg.contains("language"));
        assert!(with_dbg.contains("response_format"));
        assert!(with_dbg.contains("temperature"));
        assert!(with_dbg.contains("\"small\""));
        assert!(with_dbg.contains("\"ja\""));
        assert!(with_dbg.contains("Some"));
        assert!(without_dbg.contains("None"));
        assert!(without_dbg.contains("\"large-v3\""));
        assert!(without_dbg.contains("\"json\""));
        assert!(with_dbg.contains("0.0"));
        assert!(without_dbg.contains("0.5"));
    }

    #[test]
    fn whisper_request_params_partial_eq_holds_reflexive_and_differs_per_field() {
        let base = WhisperRequestParams {
            model: "small".to_string(),
            language: Some("ja".to_string()),
            response_format: "verbose_json".to_string(),
            temperature: 0.0,
        };

        assert_eq!(base, base.clone());

        let m_diff = WhisperRequestParams {
            model: "large-v3".to_string(),
            ..base.clone()
        };
        assert_ne!(base, m_diff);

        let l_diff = WhisperRequestParams {
            language: Some("en".to_string()),
            ..base.clone()
        };
        assert_ne!(base, l_diff);

        let l_none = WhisperRequestParams {
            language: None,
            ..base.clone()
        };
        assert_ne!(base, l_none);

        let r_diff = WhisperRequestParams {
            response_format: "json".to_string(),
            ..base.clone()
        };
        assert_ne!(base, r_diff);

        let t_diff = WhisperRequestParams {
            temperature: 0.5,
            ..base.clone()
        };
        assert_ne!(base, t_diff);
    }

    #[test]
    fn whisper_request_params_clone_is_deep_and_mutation_breaks_partial_eq() {
        let original = WhisperRequestParams {
            model: "small".to_string(),
            language: Some("ja".to_string()),
            response_format: "verbose_json".to_string(),
            temperature: 0.0,
        };
        let mut cloned = original.clone();

        assert_eq!(original, cloned, "Clone 直後は等値");

        cloned.model = "large-v3".to_string();
        cloned.language = None;
        cloned.response_format = "json".to_string();
        cloned.temperature = 0.5;

        assert_ne!(original, cloned, "全 field mutate 後は不等値");

        let original_dbg = format!("{original:?}");
        assert!(original_dbg.contains("\"small\""));
        assert!(original_dbg.contains("Some"));
        assert!(original_dbg.contains("\"ja\""));
        assert!(original_dbg.contains("\"verbose_json\""));
        assert!(original_dbg.contains("0.0"));
        assert!(!original_dbg.contains("\"large-v3\""));
        assert!(!original_dbg.contains("None"));
        assert!(!original_dbg.contains("response_format: \"json\""));
        assert!(!original_dbg.contains("0.5"));
    }

    #[test]
    fn verbose_segment_debug_format_contains_struct_name_and_all_field_values() {
        let segment = VerboseSegment {
            start: 1.5,
            end: 3.25,
            text: String::from("こんにちは"),
        };
        let formatted = format!("{segment:?}");
        assert!(
            formatted.contains("VerboseSegment"),
            "struct 名: {formatted}"
        );
        assert!(formatted.contains("start"), "start field 名: {formatted}");
        assert!(formatted.contains("1.5"), "start 値: {formatted}");
        assert!(formatted.contains("end"), "end field 名: {formatted}");
        assert!(formatted.contains("3.25"), "end 値: {formatted}");
        assert!(formatted.contains("text"), "text field 名: {formatted}");
        assert!(formatted.contains("こんにちは"), "text 値: {formatted}");
    }

    #[test]
    fn verbose_response_debug_format_contains_struct_name_and_nested_segment_values() {
        let response = VerboseResponse {
            segments: vec![
                VerboseSegment {
                    start: 0.0,
                    end: 1.0,
                    text: String::from("first"),
                },
                VerboseSegment {
                    start: 1.0,
                    end: 2.0,
                    text: String::from("second"),
                },
            ],
        };
        let formatted = format!("{response:?}");
        assert!(
            formatted.contains("VerboseResponse"),
            "outer struct 名: {formatted}"
        );
        assert!(
            formatted.contains("segments"),
            "segments field 名: {formatted}"
        );
        assert!(
            formatted.contains("VerboseSegment"),
            "inner struct 名: {formatted}"
        );
        assert!(formatted.contains("first"), "1 番目 text 値: {formatted}");
        assert!(formatted.contains("second"), "2 番目 text 値: {formatted}");
    }

    #[test]
    fn verbose_response_with_empty_segments_debug_format_contains_empty_vec_brackets() {
        let response = VerboseResponse { segments: vec![] };
        let formatted = format!("{response:?}");
        assert!(
            formatted.contains("VerboseResponse"),
            "struct 名: {formatted}"
        );
        assert!(
            formatted.contains("segments"),
            "segments field 名: {formatted}"
        );
        assert!(
            formatted.contains("[]"),
            "空 Vec の Debug 表示: {formatted}"
        );
    }

    #[test]
    fn whisper_http_request_descriptor_debug_redacts_auth_header() {
        let descriptor = WhisperHttpRequestDescriptor {
            url: String::from("https://api.openai.com/v1/audio/transcriptions"),
            auth_header: String::from("Bearer secret-api-key-12345"),
            params: WhisperRequestParams {
                model: String::from("whisper-1"),
                language: None,
                response_format: String::from("verbose_json"),
                temperature: 0.0,
            },
        };
        let formatted = format!("{descriptor:?}");
        assert!(
            formatted.contains("<redacted>"),
            "auth_header は <redacted> に置換される: {formatted}"
        );
        assert!(
            !formatted.contains("secret-api-key-12345"),
            "実 auth_header 値は Debug 出力に含まれない: {formatted}"
        );
        assert!(
            !formatted.contains("Bearer secret"),
            "Bearer prefix + 実値も含まれない: {formatted}"
        );
    }

    #[test]
    fn whisper_http_request_descriptor_debug_nests_params_and_url() {
        let descriptor = WhisperHttpRequestDescriptor {
            url: String::from("https://example.com/audio/transcriptions"),
            auth_header: String::from("Bearer xxx"),
            params: WhisperRequestParams {
                model: String::from("whisper-1"),
                language: Some(String::from("ja")),
                response_format: String::from("verbose_json"),
                temperature: 0.0,
            },
        };
        let formatted = format!("{descriptor:?}");
        assert!(
            formatted.contains("WhisperHttpRequestDescriptor"),
            "outer struct 名: {formatted}"
        );
        assert!(formatted.contains("url:"), "url field 名: {formatted}");
        assert!(
            formatted.contains("https://example.com/audio/transcriptions"),
            "url 値: {formatted}"
        );
        assert!(
            formatted.contains("WhisperRequestParams"),
            "nested struct 名: {formatted}"
        );
        assert!(
            formatted.contains("whisper-1"),
            "params.model 値: {formatted}"
        );
        assert!(formatted.contains("ja"), "params.language 値: {formatted}");
    }

    #[test]
    fn whisper_http_request_descriptor_clone_is_independent_and_eq() {
        let original = WhisperHttpRequestDescriptor {
            url: String::from("https://api.openai.com/v1/audio/transcriptions"),
            auth_header: String::from("Bearer original-key"),
            params: WhisperRequestParams {
                model: String::from("whisper-1"),
                language: Some(String::from("en")),
                response_format: String::from("verbose_json"),
                temperature: 0.0,
            },
        };
        let cloned = original.clone();
        assert_eq!(original, cloned);
        assert_eq!(original.url, cloned.url);
        assert_eq!(original.auth_header, cloned.auth_header);
        assert_eq!(original.params, cloned.params);

        let modified = WhisperHttpRequestDescriptor {
            url: String::from("https://other.example.com/transcriptions"),
            ..original.clone()
        };
        assert_ne!(original, modified, "url 変更で不等になる");
    }
}
