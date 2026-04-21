#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudWhisperError {
    InvalidApiKey,
    RateLimited,
}

#[allow(dead_code)]
pub fn classify_cloud_whisper_error(status: u16, _body: &str) -> CloudWhisperError {
    match status {
        401 => CloudWhisperError::InvalidApiKey,
        429 => CloudWhisperError::RateLimited,
        _ => CloudWhisperError::InvalidApiKey,
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
}
