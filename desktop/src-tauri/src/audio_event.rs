use serde_json::json;

pub(crate) const AUDIO_DROP_EVENT_NAME: &str = "audio-drop-count";

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
}
