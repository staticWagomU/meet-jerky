use serde_json::json;

pub(crate) fn build_audio_drop_event_payload(source: &str, dropped: usize) -> serde_json::Value {
    json!({ "source": source, "dropped": dropped })
}
