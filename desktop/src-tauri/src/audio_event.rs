use serde_json::json;

pub(crate) const AUDIO_DROP_EVENT_NAME: &str = "audio-drop-count";
pub(crate) const AUDIO_SOURCE_MICROPHONE: &str = "microphone";
pub(crate) const AUDIO_SOURCE_SYSTEM_AUDIO: &str = "system_audio";

pub(crate) fn build_audio_drop_event_payload(source: &str, dropped: usize) -> serde_json::Value {
    json!({ "source": source, "dropped": dropped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_drop_event_name_is_audio_drop_count_kebab_case() {
        assert_eq!(AUDIO_DROP_EVENT_NAME, "audio-drop-count");
    }

    #[test]
    fn audio_source_constants_are_snake_case_lowercase() {
        assert_eq!(AUDIO_SOURCE_MICROPHONE, "microphone");
        assert_eq!(AUDIO_SOURCE_SYSTEM_AUDIO, "system_audio");
    }
}
