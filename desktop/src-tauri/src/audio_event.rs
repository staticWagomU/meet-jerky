use serde_json::json;

pub(crate) const AUDIO_LEVEL_EVENT_NAME: &str = "audio-level";
pub(crate) const AUDIO_DROP_EVENT_NAME: &str = "audio-drop-count";
pub(crate) const SYSTEM_AUDIO_FORMAT_WARNING_EVENT_NAME: &str = "system-audio-format-warning";
pub(crate) const AUDIO_SOURCE_MICROPHONE: &str = "microphone";
pub(crate) const AUDIO_SOURCE_SYSTEM_AUDIO: &str = "system_audio";

pub(crate) fn build_audio_level_event_payload(source: &str, level: f32) -> serde_json::Value {
    json!({ "level": level, "source": source })
}

pub(crate) fn build_audio_drop_event_payload(source: &str, dropped: usize) -> serde_json::Value {
    json!({ "source": source, "dropped": dropped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_level_event_name_is_audio_level_kebab_case() {
        assert_eq!(AUDIO_LEVEL_EVENT_NAME, "audio-level");
    }

    #[test]
    fn audio_drop_event_name_is_audio_drop_count_kebab_case() {
        assert_eq!(AUDIO_DROP_EVENT_NAME, "audio-drop-count");
    }

    #[test]
    fn system_audio_format_warning_event_name_is_system_audio_format_warning_kebab_case() {
        assert_eq!(
            SYSTEM_AUDIO_FORMAT_WARNING_EVENT_NAME,
            "system-audio-format-warning"
        );
    }

    #[test]
    fn audio_source_constants_are_snake_case_lowercase() {
        assert_eq!(AUDIO_SOURCE_MICROPHONE, "microphone");
        assert_eq!(AUDIO_SOURCE_SYSTEM_AUDIO, "system_audio");
    }

    #[test]
    fn build_audio_level_event_payload_has_source_level_and_exactly_two_top_level_fields() {
        let payload = build_audio_level_event_payload(AUDIO_SOURCE_MICROPHONE, 0.5);
        let obj = payload.as_object().expect("payload は JSON object");

        assert_eq!(obj.len(), 2);
        assert_eq!(payload["source"], "microphone");
        assert_eq!(payload["level"], json!(0.5_f32));
    }

    #[test]
    fn build_audio_level_event_payload_with_system_audio_source_has_level_contract() {
        let payload = build_audio_level_event_payload(AUDIO_SOURCE_SYSTEM_AUDIO, 0.25);
        let obj = payload.as_object().expect("payload は JSON object");

        assert_eq!(obj.len(), 2);
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some("system_audio")
        );
        assert_eq!(payload.get("level").and_then(|v| v.as_f64()), Some(0.25));
    }

    #[test]
    fn build_audio_level_event_payload_with_empty_source_passes_through_without_normalization() {
        let payload = build_audio_level_event_payload("", 0.0);
        let obj = payload.as_object().expect("payload は JSON object");

        assert_eq!(obj.len(), 2);
        assert_eq!(payload.get("source").and_then(|v| v.as_str()), Some(""));
        assert_eq!(payload.get("level").and_then(|v| v.as_f64()), Some(0.0));
    }

    #[test]
    fn build_audio_drop_event_payload_with_microphone_source_returns_json_with_source_and_dropped_fields(
    ) {
        let payload = build_audio_drop_event_payload(AUDIO_SOURCE_MICROPHONE, 5);
        assert_eq!(payload["source"], "microphone");
        assert_eq!(payload["dropped"], 5);
    }

    #[test]
    fn build_audio_drop_event_payload_with_system_audio_source_has_dropped_contract() {
        let payload = build_audio_drop_event_payload(AUDIO_SOURCE_SYSTEM_AUDIO, 7);
        let obj = payload.as_object().expect("payload は JSON object");

        assert_eq!(obj.len(), 2);
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some("system_audio")
        );
        assert_eq!(payload.get("dropped").and_then(|v| v.as_u64()), Some(7));
    }

    #[test]
    fn build_audio_drop_event_payload_with_empty_source_passes_through_without_normalization() {
        let payload = build_audio_drop_event_payload("", 0);
        assert_eq!(payload["source"], "");
        assert_eq!(payload["dropped"], 0);
    }

    #[test]
    fn build_audio_drop_event_payload_with_usize_max_dropped_serializes_without_overflow() {
        let payload = build_audio_drop_event_payload(AUDIO_SOURCE_SYSTEM_AUDIO, usize::MAX);
        assert_eq!(payload["source"], "system_audio");
        assert_eq!(payload["dropped"], usize::MAX);
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::build_audio_drop_event_payload;

    pub(crate) fn assert_drop_payload_includes_source_and_dropped_fields(
        source: &str,
        dropped: usize,
    ) {
        let payload = build_audio_drop_event_payload(source, dropped);
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some(source),
            "source field が文字列で含まれる契約"
        );
        assert_eq!(
            payload.get("dropped").and_then(|v| v.as_u64()),
            Some(dropped as u64),
            "dropped field が u64 として含まれる契約"
        );
    }

    pub(crate) fn assert_drop_payload_serializes_zero_dropped_count_explicitly(source: &str) {
        let payload = build_audio_drop_event_payload(source, 0);
        assert_eq!(payload.get("dropped").and_then(|v| v.as_u64()), Some(0));
    }

    pub(crate) fn assert_drop_payload_handles_usize_max_boundary(source: &str) {
        let payload = build_audio_drop_event_payload(source, usize::MAX);
        assert_eq!(
            payload.get("dropped").and_then(|v| v.as_u64()),
            Some(usize::MAX as u64),
            "usize::MAX が u64 として serde_json に渡せる契約"
        );
    }

    pub(crate) fn assert_drop_payload_passes_through_arbitrary_source_labels(
        label_a: &str,
        label_b: &str,
    ) {
        let payload = build_audio_drop_event_payload(label_a, 1);
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some(label_a)
        );
        let payload2 = build_audio_drop_event_payload(label_b, 1);
        assert_eq!(
            payload2.get("source").and_then(|v| v.as_str()),
            Some(label_b),
            "source は arbitrary passthrough = source を判定する誤改修への検知装置"
        );
    }

    pub(crate) fn assert_drop_payload_has_exactly_two_top_level_fields(source: &str) {
        let payload = build_audio_drop_event_payload(source, 5);
        let obj = payload.as_object().expect("payload は JSON object");
        assert_eq!(
            obj.len(),
            2,
            "top-level field は exactly 2 つ (source + dropped) の契約: 実際 = {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(obj.contains_key("source"));
        assert!(obj.contains_key("dropped"));
    }
}
