use std::sync::Arc;

use parking_lot::Mutex;

use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

/// Realtime engine 共通: ws_task 内で発生したエラーを segment text に流す。
/// engine_label = "ElevenLabs" / "OpenAI" 等。
pub(crate) fn push_error(
    engine_label: &str,
    pending: &Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: &Option<String>,
    source: Option<TranscriptionSource>,
    message: String,
) {
    pending.lock().push(TranscriptionSegment {
        text: format!("[{engine_label} Realtime エラー: {message}]"),
        start_ms: 0,
        end_ms: 0,
        source,
        speaker: speaker.clone(),
        is_error: Some(true),
    });
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use std::sync::Arc;

    use parking_lot::Mutex;

    use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

    pub(crate) fn assert_push_error_format_prefix_and_suffix_are_fixed(engine_label: &str) {
        let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
        let speaker = Some("自分".to_string());

        super::push_error(
            engine_label,
            &pending,
            &speaker,
            Some(TranscriptionSource::Microphone),
            "connection closed".to_string(),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 1);
        // prefix と suffix を含む完全一致で文言契約を強制 (engine_label は呼び出し側パラメータ).
        assert_eq!(
            segments[0].text,
            format!("[{engine_label} Realtime エラー: connection closed]")
        );
    }

    pub(crate) fn assert_push_error_sets_zero_timestamps_and_is_error_true(engine_label: &str) {
        let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
        let speaker = Some("自分".to_string());

        super::push_error(
            engine_label,
            &pending,
            &speaker,
            Some(TranscriptionSource::Microphone),
            "rate limit".to_string(),
        );

        let segments = pending.lock();
        assert_eq!(segments.len(), 1);
        // エラーセグメント identity 契約: 時刻情報なし + is_error=Some(true)
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 0);
        assert_eq!(segments[0].is_error, Some(true));
    }

    pub(crate) fn assert_push_error_passes_source_through(engine_label: &str) {
        // ケース 1: Some(Microphone) は Some(Microphone) のまま渡る
        {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());
            super::push_error(
                engine_label,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "err".to_string(),
            );
            assert_eq!(
                pending.lock()[0].source,
                Some(TranscriptionSource::Microphone)
            );
        }

        // ケース 2: None は None のまま渡る
        {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());
            super::push_error(engine_label, &pending, &speaker, None, "err".to_string());
            assert_eq!(pending.lock()[0].source, None);
        }
    }

    pub(crate) fn assert_push_error_clones_speaker_field(engine_label: &str) {
        // ケース 1: Some("自分") が clone されて渡る (元の所有権は保持される)
        {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());
            super::push_error(
                engine_label,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "err".to_string(),
            );
            assert_eq!(pending.lock()[0].speaker, Some("自分".to_string()));
            // 元の speaker が clone 後も有効であることを確認 (move されていない)
            assert_eq!(speaker, Some("自分".to_string()));
        }

        // ケース 2: None は None のまま渡る
        {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker: Option<String> = None;
            super::push_error(
                engine_label,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "err".to_string(),
            );
            assert_eq!(pending.lock()[0].speaker, None);
        }
    }

    pub(crate) fn assert_push_error_with_empty_and_multibyte_messages_preserve_text_format(
        engine_label: &str,
    ) {
        // ケース 1: 空 message でも prefix/suffix が残り "[<engine_label> Realtime エラー: ]" になる
        {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());
            super::push_error(
                engine_label,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "".to_string(),
            );
            assert_eq!(
                pending.lock()[0].text,
                format!("[{engine_label} Realtime エラー: ]")
            );
        }

        // ケース 2: 日本語マルチバイト message が prefix/suffix の間にそのまま埋め込まれる
        {
            let pending: Arc<Mutex<Vec<TranscriptionSegment>>> = Arc::new(Mutex::new(Vec::new()));
            let speaker = Some("自分".to_string());
            super::push_error(
                engine_label,
                &pending,
                &speaker,
                Some(TranscriptionSource::Microphone),
                "認証エラーが発生しました".to_string(),
            );
            assert_eq!(
                pending.lock()[0].text,
                format!("[{engine_label} Realtime エラー: 認証エラーが発生しました]")
            );
        }
    }
}
