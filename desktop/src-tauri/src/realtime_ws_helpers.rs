//! elevenlabs_realtime `mod ws_task` 内の純粋関数 helpers (is_scribe_error_event / wait_for_pending_after_commit / extract_transcript / extract_error_message)。
//!
//! Loop 102 で elevenlabs_realtime.rs から分離。state 依存ゼロの純粋関数のみ。

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;

use crate::transcription_types::TranscriptionSegment;

pub(crate) fn is_scribe_error_event(event_name: &str) -> bool {
    event_name.starts_with("scribe_") && event_name.ends_with("_error")
}

// commit 送信後、ElevenLabs Realtime の最終 committed_transcript 到着を最大 timeout 秒待つ。
// 長めの最終発話による取りこぼしを抑制するための値で、OpenAI 側 READER_FINALIZE_TIMEOUT と整合させている。
pub(crate) async fn wait_for_pending_after_commit(
    pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
    previous_len: usize,
    timeout: Duration,
) {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if pending.lock().len() > previous_len {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(crate) fn extract_transcript(value: &Value) -> Option<String> {
    value
        .get("transcript")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("text").and_then(|v| v.as_str()))
        .map(str::to_string)
        .or_else(|| {
            value.get("words").and_then(|v| v.as_array()).map(|words| {
                words
                    .iter()
                    .filter_map(|word| {
                        word.get("text")
                            .or_else(|| word.get("word"))
                            .and_then(|v| v.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
        })
}

pub(crate) fn extract_error_message(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("error").and_then(|v| v.as_str()))
        .or_else(|| {
            value
                .get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;

    use crate::transcription_types::TranscriptionSegment;

    fn make_segment() -> TranscriptionSegment {
        TranscriptionSegment {
            text: "segment".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: None,
            is_error: None,
        }
    }

    #[tokio::test]
    async fn wait_for_pending_after_commit_returns_when_pending_grows() {
        let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(vec![]));
        let clone = Arc::clone(&pending);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            clone.lock().push(make_segment());
        });
        let t = Instant::now();
        super::wait_for_pending_after_commit(&pending, 0, Duration::from_millis(500)).await;
        assert_eq!(
            pending.lock().len(),
            1,
            "pending が成長したら早期 return するはず"
        );
        assert!(
            t.elapsed() < Duration::from_millis(400),
            "deadline より早く return するはず"
        );
    }

    #[tokio::test]
    async fn wait_for_pending_after_commit_returns_after_deadline_when_pending_unchanged() {
        let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(vec![]));
        let t = Instant::now();
        super::wait_for_pending_after_commit(&pending, 0, Duration::from_millis(150)).await;
        assert!(
            t.elapsed() >= Duration::from_millis(100),
            "deadline 経過後に return するはず"
        );
        assert_eq!(pending.lock().len(), 0);
    }

    #[tokio::test]
    async fn wait_for_pending_after_commit_returns_immediately_when_already_grown() {
        let pending: Arc<Mutex<Vec<TranscriptionSegment>>> =
            Arc::new(Mutex::new(vec![make_segment()]));
        let t = Instant::now();
        super::wait_for_pending_after_commit(&pending, 0, Duration::from_secs(10)).await;
        assert!(
            t.elapsed() < Duration::from_millis(100),
            "既に pending > previous_len なら即 return するはず"
        );
    }

    #[test]
    fn is_scribe_error_event_returns_true_for_scribe_prefix_and_error_suffix() {
        assert!(super::is_scribe_error_event("scribe_validation_error"));
        assert!(super::is_scribe_error_event("scribe_audio_error"));
        assert!(super::is_scribe_error_event(
            "scribe_some_long_underscore_error"
        ));
    }

    #[test]
    fn is_scribe_error_event_returns_false_when_either_prefix_or_suffix_missing() {
        assert!(!super::is_scribe_error_event("scribe_audio"));
        assert!(!super::is_scribe_error_event("audio_error"));
        assert!(!super::is_scribe_error_event(""));
        assert!(!super::is_scribe_error_event("non_scribe_error"));
        assert!(!super::is_scribe_error_event("SCRIBE_ERROR"));
    }

    #[test]
    fn extract_transcript_prefers_transcript_field_over_text_field() {
        let value = serde_json::json!({ "transcript": "hello", "text": "ignored" });
        assert_eq!(super::extract_transcript(&value), Some("hello".to_string()));

        let value = serde_json::json!({ "text": "fallback only" });
        assert_eq!(
            super::extract_transcript(&value),
            Some("fallback only".to_string())
        );
    }

    #[test]
    fn extract_transcript_falls_back_to_words_array_with_text_or_word_keys() {
        let value = serde_json::json!({
            "words": [{"text": "hello"}, {"word": " world"}, {"text": "!"}]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("hello world!".to_string())
        );

        let value = serde_json::json!({ "words": [] });
        assert_eq!(super::extract_transcript(&value), Some("".to_string()));

        let value = serde_json::json!({ "words": [{"unrelated": "x"}] });
        assert_eq!(super::extract_transcript(&value), Some("".to_string()));
    }

    #[test]
    fn extract_transcript_returns_none_when_no_relevant_field_present() {
        let value = serde_json::json!({});
        assert_eq!(super::extract_transcript(&value), None);

        let value = serde_json::json!({ "unrelated": "x", "other": 42 });
        assert_eq!(super::extract_transcript(&value), None);

        let value = serde_json::json!({ "transcript": 123 });
        assert_eq!(super::extract_transcript(&value), None);
    }

    #[test]
    fn extract_error_message_traverses_three_priority_paths() {
        let value = serde_json::json!({ "message": "top-level message", "error": "ignored" });
        assert_eq!(
            super::extract_error_message(&value),
            Some("top-level message".to_string())
        );

        let value = serde_json::json!({ "error": "string-error" });
        assert_eq!(
            super::extract_error_message(&value),
            Some("string-error".to_string())
        );

        let value = serde_json::json!({ "error": { "message": "nested" } });
        assert_eq!(
            super::extract_error_message(&value),
            Some("nested".to_string())
        );

        let value = serde_json::json!({});
        assert_eq!(super::extract_error_message(&value), None);
    }

    #[test]
    fn is_scribe_error_event_returns_true_for_minimal_overlap_scribe_error() {
        // prefix と suffix が共有 _ で接する最短形も true になる現契約を固定。
        assert!(super::is_scribe_error_event("scribe_error"));
        assert!(super::is_scribe_error_event("scribe_x_error"));
    }

    #[test]
    fn is_scribe_error_event_returns_true_for_zero_length_middle_scribe_double_underscore_error() {
        // "scribe__error" は独立した _ 2 個で && 最小条件を真に満たす。中間 0 長も true の boundary を固定。
        assert!(super::is_scribe_error_event("scribe__error"));
        assert!(super::is_scribe_error_event("scribe_a_error"));
        assert!(!super::is_scribe_error_event("scribe"));
        assert!(!super::is_scribe_error_event("_error"));
    }

    #[test]
    fn extract_error_message_falls_back_to_priority2_when_priority1_message_is_non_string() {
        // priority1 (message) が非文字列なら or_else で priority2 (error string) へ fallback する現契約を固定。
        let value = serde_json::json!({ "message": null, "error": "fallback string" });
        assert_eq!(
            super::extract_error_message(&value),
            Some("fallback string".to_string())
        );

        let value = serde_json::json!({ "message": 123, "error": "from-error" });
        assert_eq!(
            super::extract_error_message(&value),
            Some("from-error".to_string())
        );

        let value = serde_json::json!({ "message": [], "error": "array-message-skip" });
        assert_eq!(
            super::extract_error_message(&value),
            Some("array-message-skip".to_string())
        );
    }

    #[test]
    fn extract_error_message_falls_back_to_priority3_when_priority2_error_is_non_string() {
        // priority2 (error) が object/null なら priority3 (error.message) へ fallback する現契約を固定。
        let value = serde_json::json!({ "error": { "message": "deep nested" } });
        assert_eq!(
            super::extract_error_message(&value),
            Some("deep nested".to_string())
        );

        let value = serde_json::json!({
            "message": null,
            "error": { "message": "deep with priority1 null" }
        });
        assert_eq!(
            super::extract_error_message(&value),
            Some("deep with priority1 null".to_string())
        );

        let value = serde_json::json!({ "error": null });
        assert_eq!(super::extract_error_message(&value), None);
    }

    #[test]
    fn extract_error_message_returns_none_when_all_priorities_yield_non_string() {
        // 全 priority が非文字列な 4 シナリオで終端 None 返却を固定。
        let value = serde_json::json!({ "message": null, "error": null });
        assert_eq!(super::extract_error_message(&value), None);

        let value = serde_json::json!({ "message": [], "error": {} });
        assert_eq!(super::extract_error_message(&value), None);

        let value = serde_json::json!({ "error": { "message": null } });
        assert_eq!(super::extract_error_message(&value), None);

        let value = serde_json::json!({ "message": 1.5, "error": [1, 2], "extra": "noise" });
        assert_eq!(super::extract_error_message(&value), None);
    }

    #[test]
    fn extract_transcript_falls_back_to_text_when_transcript_is_non_string() {
        // ケース 1: transcript=null, text="fallback" → text を採用
        let value = serde_json::json!({ "transcript": null, "text": "fallback" });
        assert_eq!(
            super::extract_transcript(&value),
            Some("fallback".to_string()),
            "transcript=null は as_str() で None、text へ or_else fallback するはず"
        );

        // ケース 2: transcript=number, text="from text"
        let value = serde_json::json!({ "transcript": 42, "text": "from text" });
        assert_eq!(
            super::extract_transcript(&value),
            Some("from text".to_string()),
            "transcript=number は as_str() で None、text へ or_else fallback するはず"
        );

        // ケース 3: transcript=array, text="x"
        let value = serde_json::json!({ "transcript": ["a", "b"], "text": "x" });
        assert_eq!(
            super::extract_transcript(&value),
            Some("x".to_string()),
            "transcript=array は as_str() で None、text へ or_else fallback するはず"
        );
    }

    #[test]
    fn extract_transcript_falls_back_to_words_when_transcript_and_text_are_non_string() {
        // ケース 1: transcript=null, text=null, words=[{"text":"a"},{"word":"b"}] → "ab"
        let value = serde_json::json!({
            "transcript": null,
            "text": null,
            "words": [{ "text": "a" }, { "word": "b" }]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("ab".to_string()),
            "transcript/text 両方 null なら words array へ fallback、text/word 両方拾うはず"
        );

        // ケース 2: transcript=number, text=array, words=[{"text":"x"}] → "x"
        let value = serde_json::json!({
            "transcript": 42,
            "text": ["nested", "array"],
            "words": [{ "text": "x" }]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("x".to_string()),
            "transcript=number と text=array で 2 段抜けて words へ fallback するはず"
        );

        // ケース 3: transcript field 無し、text=number, words=[] → Some("") (空 array でも Some)
        let value = serde_json::json!({ "text": 99, "words": [] });
        assert_eq!(
            super::extract_transcript(&value),
            Some("".to_string()),
            "text=number で 1 段抜け、words=[] でも array なので Some(\"\") のはず"
        );
    }

    #[test]
    fn extract_transcript_returns_none_when_words_field_is_non_array() {
        // ケース 1: words=null
        let value = serde_json::json!({ "words": null });
        assert_eq!(
            super::extract_transcript(&value),
            None,
            "words=null は as_array() で None、最終的に None のはず"
        );

        // ケース 2: words=number
        let value = serde_json::json!({ "words": 42 });
        assert_eq!(
            super::extract_transcript(&value),
            None,
            "words=number は as_array() で None のはず"
        );

        // ケース 3: words=string
        let value = serde_json::json!({ "words": "not-an-array" });
        assert_eq!(
            super::extract_transcript(&value),
            None,
            "words=string は as_array() で None のはず"
        );

        // ケース 4: words=object
        let value = serde_json::json!({ "words": { "text": "still-not-array" } });
        assert_eq!(
            super::extract_transcript(&value),
            None,
            "words=object は as_array() で None のはず (top-level の text 探索とは独立)"
        );
    }

    #[test]
    fn extract_transcript_does_not_fall_back_within_word_entry_when_text_is_non_string() {
        // ケース 1: words=[{"text":null,"word":"actual"}] → Some("")
        // text=null は Some(Value::Null) なので or_else が動かず、as_str() で None、skip される現契約
        let value = serde_json::json!({
            "words": [{ "text": null, "word": "actual" }]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("".to_string()),
            "text=null は or_else が動かず (Some(Null) だから)、as_str() で None、skip され Some(\"\") になる現契約のはず"
        );

        // ケース 2: words=[{"text":42,"word":"y"}] → Some("")
        let value = serde_json::json!({
            "words": [{ "text": 42, "word": "y" }]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("".to_string()),
            "text=number でも or_else 動かず、word fallback されない現契約"
        );

        // ケース 3: text field absent、word="z" → Some("z") (or_else が初めて動く)
        let value = serde_json::json!({
            "words": [{ "word": "z" }]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("z".to_string()),
            "text field 自体無しなら or_else で word が採用される (text=non-string とは違う経路)"
        );
    }

    #[test]
    fn extract_transcript_joins_only_string_entries_in_mixed_words_array_in_order() {
        // ケース 1: 適合 (text=str, word=str) と非適合 (unrelated, text=null+word=null) が混在
        let value = serde_json::json!({
            "words": [
                { "text": "a" },
                { "unrelated": "skip" },
                { "text": null, "word": null },
                { "word": "c" }
            ]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("ac".to_string()),
            "適合 entry のみ順序保ったまま join、非適合は skip されるはず"
        );

        // ケース 2: 全 entry が non-string field のみ → Some("") (空 join)
        let value = serde_json::json!({
            "words": [
                { "text": 42 },
                { "word": 99 },
                { "text": null, "word": null }
            ]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("".to_string()),
            "全 entry が非適合なら空文字 Some(\"\") を返すはず (None ではない)"
        );

        // ケース 3: 順序保証 regression sanity check (text を 3 つ並べる)
        let value = serde_json::json!({
            "words": [{ "text": "x" }, { "text": "y" }, { "text": "z" }]
        });
        assert_eq!(
            super::extract_transcript(&value),
            Some("xyz".to_string()),
            "filter_map と join の順序が保たれるはず"
        );
    }
}
