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
}
