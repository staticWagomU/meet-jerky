#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudWhisperError {
    InvalidApiKey,
    RateLimited,
    ServerError,
    Other { status: u16, message: String },
}

#[allow(dead_code)]
pub fn classify_cloud_whisper_error(status: u16, body: &str) -> CloudWhisperError {
    match status {
        401 => CloudWhisperError::InvalidApiKey,
        429 => CloudWhisperError::RateLimited,
        500..=599 => CloudWhisperError::ServerError,
        _ => CloudWhisperError::Other {
            status,
            message: sanitize_error_body(body),
        },
    }
}

const MAX_ERROR_BODY_CHARS: usize = 200;

fn sanitize_error_body(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let was_truncated = normalized.chars().count() > MAX_ERROR_BODY_CHARS;
    let sanitized: String = normalized.chars().take(MAX_ERROR_BODY_CHARS).collect();

    if sanitized.is_empty() {
        "HTTP error body was empty".to_string()
    } else if was_truncated {
        format!("{sanitized}...")
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_401_returns_invalid_api_key() {
        assert_eq!(
            classify_cloud_whisper_error(401, "some body"),
            CloudWhisperError::InvalidApiKey
        );
    }

    #[test]
    fn classify_429_returns_rate_limited() {
        assert_eq!(
            classify_cloud_whisper_error(429, ""),
            CloudWhisperError::RateLimited
        );
    }

    #[test]
    fn classify_server_and_other_errors() {
        assert_eq!(
            classify_cloud_whisper_error(500, ""),
            CloudWhisperError::ServerError
        );
        assert_eq!(
            classify_cloud_whisper_error(599, ""),
            CloudWhisperError::ServerError
        );
        assert_eq!(
            classify_cloud_whisper_error(400, "bad request body"),
            CloudWhisperError::Other {
                status: 400,
                message: "bad request body".to_string(),
            }
        );
    }

    #[test]
    fn classify_other_error_sanitizes_body() {
        assert_eq!(
            classify_cloud_whisper_error(400, "  first line\n\tsecond line  "),
            CloudWhisperError::Other {
                status: 400,
                message: "first line second line".to_string(),
            }
        );
        assert_eq!(
            classify_cloud_whisper_error(418, ""),
            CloudWhisperError::Other {
                status: 418,
                message: "HTTP error body was empty".to_string(),
            }
        );

        let long_body = "x".repeat(MAX_ERROR_BODY_CHARS + 20);
        let CloudWhisperError::Other { message, .. } =
            classify_cloud_whisper_error(400, &long_body)
        else {
            panic!("400 should classify as Other");
        };
        assert_eq!(message.len(), MAX_ERROR_BODY_CHARS + 3);
        assert!(message.ends_with("..."));
    }

    #[test]
    fn classify_499_returns_other() {
        assert_eq!(
            classify_cloud_whisper_error(499, "boundary-before-5xx"),
            CloudWhisperError::Other {
                status: 499,
                message: "boundary-before-5xx".to_string(),
            }
        );
    }

    #[test]
    fn classify_600_returns_other() {
        assert_eq!(
            classify_cloud_whisper_error(600, "boundary-after-5xx"),
            CloudWhisperError::Other {
                status: 600,
                message: "boundary-after-5xx".to_string(),
            }
        );
    }

    #[test]
    fn classify_200_returns_other_safely() {
        assert_eq!(
            classify_cloud_whisper_error(200, "unexpected success in error path"),
            CloudWhisperError::Other {
                status: 200,
                message: "unexpected success in error path".to_string(),
            }
        );
    }

    #[test]
    fn sanitize_error_body_falls_back_to_empty_marker_for_whitespace_only_inputs() {
        assert_eq!(super::sanitize_error_body(""), "HTTP error body was empty");
        assert_eq!(
            super::sanitize_error_body("   "),
            "HTTP error body was empty"
        );
        assert_eq!(
            super::sanitize_error_body("\t\n  "),
            "HTTP error body was empty"
        );
    }

    #[test]
    fn sanitize_error_body_truncates_multibyte_text_by_char_count_not_byte_count() {
        let body = "あ".repeat(super::MAX_ERROR_BODY_CHARS + 5);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), super::MAX_ERROR_BODY_CHARS + 3);
        assert!(result.ends_with("..."));
        assert!(result.starts_with("あ"));
    }

    #[test]
    fn sanitize_error_body_does_not_truncate_at_199_chars() {
        let body = "x".repeat(super::MAX_ERROR_BODY_CHARS - 1);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), 199);
        assert_eq!(result, "x".repeat(199));
        assert!(!result.ends_with("..."));
    }

    #[test]
    fn sanitize_error_body_does_not_truncate_at_exactly_200_chars() {
        let body = "x".repeat(super::MAX_ERROR_BODY_CHARS);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), 200);
        assert_eq!(result, "x".repeat(200));
        assert!(!result.ends_with("..."));
    }

    #[test]
    fn sanitize_error_body_truncates_at_201_chars() {
        let body = "x".repeat(super::MAX_ERROR_BODY_CHARS + 1);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), super::MAX_ERROR_BODY_CHARS + 3);
        assert!(result.ends_with("..."));
        assert!(result.starts_with(&"x".repeat(super::MAX_ERROR_BODY_CHARS)));
    }

    #[test]
    fn sanitize_error_body_normalizes_whitespace_before_counting_chars() {
        // 100 "x"s joined by 4 spaces: raw = 100 + 99*4 = 496 chars (> MAX=200),
        // but split_whitespace().join(" ") yields 100 + 99 = 199 chars (< MAX).
        let body = (0..100).map(|_| "x").collect::<Vec<_>>().join("    ");
        assert_eq!(body.chars().count(), 496);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), 199);
        assert!(!result.ends_with("..."));
        assert_eq!(result, (0..100).map(|_| "x").collect::<Vec<_>>().join(" "));
    }

    #[test]
    fn sanitize_error_body_truncates_multibyte_at_exactly_201_chars() {
        let body = "あ".repeat(super::MAX_ERROR_BODY_CHARS + 1);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), super::MAX_ERROR_BODY_CHARS + 3);
        assert!(result.ends_with("..."));
        assert!(result.starts_with("あ"));
        assert!(result
            .chars()
            .take(super::MAX_ERROR_BODY_CHARS)
            .all(|c| c == 'あ'));
    }
}
