#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudWhisperError {
    InvalidApiKey,
}

#[allow(dead_code)]
pub fn classify_cloud_whisper_error(_status: u16, _body: &str) -> CloudWhisperError {
    CloudWhisperError::InvalidApiKey
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
}
