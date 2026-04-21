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
            message: body.to_string(),
        },
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
}
