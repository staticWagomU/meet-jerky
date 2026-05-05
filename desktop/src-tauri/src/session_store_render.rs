//! セッションを Markdown 文字列にレンダリングする内部ヘルパー module。
//!
//! ファイル I/O は session_store.rs に閉じ込めるため、こちらは pure な変換専門。

use std::io::{Error, ErrorKind};

use chrono::FixedOffset;

use crate::datetime_fmt::{
    format_segment_timestamp_with_offset, format_session_header_timestamp_with_offset,
};
use crate::markdown::{self, SessionMeta};
use crate::session::Session;

/// セッションを Markdown 文字列に整形する内部ヘルパー。
pub(crate) fn render_session_markdown(
    session: &Session,
    offset: FixedOffset,
) -> std::io::Result<String> {
    let started_at_secs = unix_secs_i64("session started_at", session.started_at)?;
    let header_display =
        format_session_header_timestamp_with_offset(started_at_secs, offset).map_err(io_invalid)?;
    let meta = SessionMeta {
        title: session.title.clone(),
        started_at_display: header_display,
    };

    let segments: Vec<markdown::SessionSegment> = session
        .segments
        .iter()
        .map(|s| {
            let segment_abs_secs = session
                .started_at
                .checked_add(s.timestamp_offset_secs)
                .ok_or_else(|| io_invalid("session segment timestamp overflow"))?;
            let segment_abs_secs = unix_secs_i64("session segment timestamp", segment_abs_secs)?;
            let timestamp_display = format_segment_timestamp_with_offset(segment_abs_secs, offset)
                .map_err(io_invalid)?;

            Ok(markdown::SessionSegment {
                speaker: s.speaker.clone(),
                timestamp_display,
                text: s.text.clone(),
            })
        })
        .collect::<std::io::Result<_>>()?;

    Ok(markdown::format_session_markdown(&meta, &segments))
}

fn unix_secs_i64(label: &str, unix_secs: u64) -> std::io::Result<i64> {
    i64::try_from(unix_secs)
        .map_err(|_| io_invalid(format!("{label} is out of i64 range: {unix_secs}")))
}

fn io_invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::ErrorKind;

    use chrono::FixedOffset;
    use tempfile::tempdir;

    use crate::session::Session;
    use crate::session_store::save_session_markdown;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    #[test]
    fn render_session_markdown_returns_same_content_as_save_session_markdown() {
        let mut session = Session::start("会議メモ".to_string(), 1_700_000_000);
        session.append_segment("自分".into(), 15, "hello".into());
        let dir = tempdir().unwrap();

        let rendered = render_session_markdown(&session, jst()).unwrap();
        let saved_path = save_session_markdown(dir.path(), &session, jst()).unwrap();
        let saved_content = fs::read_to_string(&saved_path).unwrap();

        assert_eq!(
            rendered, saved_content,
            "render_session_markdown と save_session_markdown+read は同じ markdown を生成する契約"
        );
    }

    #[test]
    fn render_session_markdown_returns_invalid_input_error_when_started_at_exceeds_i64() {
        let session = Session::start("会議メモ".to_string(), u64::MAX);

        let err = render_session_markdown(&session, jst()).unwrap_err();

        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("session started_at"),
            "error message に 'session started_at' が含まれる契約: {err}"
        );
    }

    #[test]
    fn render_session_markdown_returns_invalid_input_error_when_segment_timestamp_overflows_checked_add(
    ) {
        let mut session = Session::start("会議メモ".to_string(), 1_700_000_000);
        session.append_segment("自分".into(), u64::MAX, "hello".into());

        let err = render_session_markdown(&session, jst()).unwrap_err();

        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string()
                .contains("session segment timestamp overflow"),
            "error message に 'session segment timestamp overflow' が含まれる契約: {err}"
        );
    }

    #[test]
    fn render_session_markdown_succeeds_with_zero_segments() {
        let session = Session::start("会議メモ".to_string(), 1_700_000_000);

        let result = render_session_markdown(&session, jst()).unwrap();

        assert!(
            !result.contains("session segment timestamp"),
            "空 segments では segment 行が生成されない契約: {result}"
        );
    }

    #[test]
    fn render_session_markdown_returns_invalid_input_error_when_segment_abs_exceeds_i64() {
        let started_at = 1_700_000_000u64;
        let offset_secs = (i64::MAX as u64 + 1) - started_at;
        let mut session = Session::start("会議メモ".to_string(), started_at);
        session.append_segment("自分".into(), offset_secs, "hello".into());

        let err = render_session_markdown(&session, jst()).unwrap_err();

        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("session segment timestamp"),
            "error message に 'session segment timestamp' が含まれる契約: {err}"
        );
    }

    #[test]
    fn unix_secs_i64_returns_value_for_valid_u64_inputs() {
        assert_eq!(unix_secs_i64("test", 0).unwrap(), 0);
        assert_eq!(unix_secs_i64("test", i64::MAX as u64).unwrap(), i64::MAX);
    }

    #[test]
    fn unix_secs_i64_returns_invalid_input_error_for_overflow() {
        assert_eq!(
            unix_secs_i64("test", (i64::MAX as u64) + 1)
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            unix_secs_i64("test", u64::MAX).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn unix_secs_i64_error_message_includes_label_and_value_exactly() {
        assert_eq!(
            unix_secs_i64("session started_at", u64::MAX)
                .unwrap_err()
                .to_string(),
            "session started_at is out of i64 range: 18446744073709551615"
        );
    }

    #[test]
    fn io_invalid_always_returns_invalid_input_kind_with_passed_message() {
        let e1 = io_invalid("any message");
        assert_eq!(e1.kind(), ErrorKind::InvalidInput);
        assert_eq!(e1.to_string(), "any message");
        let e2 = io_invalid("別のメッセージ");
        assert_eq!(e2.kind(), ErrorKind::InvalidInput);
        assert_eq!(e2.to_string(), "別のメッセージ");
    }
}
