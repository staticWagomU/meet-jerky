//! Unix時刻（秒）を、Markdown出力に使う表示文字列へ整形するユーティリティ。
//!
//! TDDのため、テスト可能な `*_with_offset` 関数を公開する。
//! プロダクション側のローカルタイム用ラッパーは別途追加予定。

use chrono::{DateTime, FixedOffset, TimeZone};

/// セッションヘッダ用のタイムスタンプ（`YYYY-MM-DD HH:MM`）を指定オフセットで整形する。
pub fn format_session_header_timestamp_with_offset(
    unix_secs: i64,
    offset: FixedOffset,
) -> Result<String, String> {
    let dt: DateTime<FixedOffset> = offset
        .timestamp_opt(unix_secs, 0)
        .single()
        .ok_or_else(|| format!("Unix timestamp is out of range: {unix_secs}"))?;
    Ok(dt.format("%Y-%m-%d %H:%M").to_string())
}

/// セグメント行用のタイムスタンプ（`HH:MM:SS`）を指定オフセットで整形する。
pub fn format_segment_timestamp_with_offset(
    unix_secs: i64,
    offset: FixedOffset,
) -> Result<String, String> {
    let dt: DateTime<FixedOffset> = offset
        .timestamp_opt(unix_secs, 0)
        .single()
        .ok_or_else(|| format!("Unix timestamp is out of range: {unix_secs}"))?;
    Ok(dt.format("%H:%M:%S").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    #[test]
    fn test_format_session_header_timestamp_with_offset_jst() {
        // 1_713_333_000 UTC = 2024-04-17 05:50:00 UTC → JST 14:50
        let s = format_session_header_timestamp_with_offset(1_713_333_000, jst()).unwrap();
        assert_eq!(s, "2024-04-17 14:50");
    }

    #[test]
    fn test_format_segment_timestamp_with_offset_jst() {
        // 1_713_333_015 UTC = 2024-04-17 05:50:15 UTC → JST 14:50:15
        let s = format_segment_timestamp_with_offset(1_713_333_015, jst()).unwrap();
        assert_eq!(s, "14:50:15");
    }

    #[test]
    fn test_format_session_header_timestamp_crosses_midnight_in_jst() {
        // 1_713_369_585 UTC = 2024-04-17 15:59:45 UTC。JST(+9h)では翌日 2024-04-18 00:59。
        // 日付がUTCとJSTで異なる境界ケースで、日付もオフセット込みで繰り上がることを確認する。
        let s = format_session_header_timestamp_with_offset(1_713_369_585, jst()).unwrap();
        assert_eq!(s, "2024-04-18 00:59");
    }

    #[test]
    fn format_session_header_timestamp_returns_error_for_out_of_range_unix_secs() {
        let err = format_session_header_timestamp_with_offset(i64::MAX, jst()).unwrap_err();

        assert!(
            err.contains("out of range"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn format_segment_timestamp_returns_error_for_out_of_range_unix_secs() {
        let err = format_segment_timestamp_with_offset(i64::MAX, jst()).unwrap_err();

        assert!(
            err.contains("out of range"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn format_session_header_and_segment_with_utc_offset_zero_match_utc_time() {
        // 1_713_333_000 = 2024-04-17 05:50:00 UTC。offset=0 で UTC 生時刻がそのまま表示される契約を固定。
        let utc = FixedOffset::east_opt(0).unwrap();
        let header = format_session_header_timestamp_with_offset(1_713_333_000, utc).unwrap();
        let segment = format_segment_timestamp_with_offset(1_713_333_000, utc).unwrap();
        assert_eq!(header, "2024-04-17 05:50");
        assert_eq!(segment, "05:50:00");
    }

    #[test]
    fn format_session_header_with_negative_offset_crosses_midnight_to_previous_day() {
        // 1_713_326_400 = 2024-04-17 04:00:00 UTC。UTC-5 では 2024-04-16 23:00 (日付繰り下がり)。
        let utc_minus_5 = FixedOffset::west_opt(5 * 3600).unwrap();
        let header =
            format_session_header_timestamp_with_offset(1_713_326_400, utc_minus_5).unwrap();
        assert_eq!(header, "2024-04-16 23:00");
    }

    #[test]
    fn format_session_header_and_segment_at_unix_epoch_zero_returns_1970_01_01() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let header = format_session_header_timestamp_with_offset(0, utc).unwrap();
        let segment = format_segment_timestamp_with_offset(0, utc).unwrap();
        assert_eq!(header, "1970-01-01 00:00");
        assert_eq!(segment, "00:00:00");
    }

    #[test]
    fn format_error_message_includes_specific_unix_secs_value() {
        let err1 = format_session_header_timestamp_with_offset(i64::MAX, jst()).unwrap_err();
        let err2 = format_segment_timestamp_with_offset(i64::MAX, jst()).unwrap_err();
        assert_eq!(
            err1,
            format!("Unix timestamp is out of range: {}", i64::MAX)
        );
        assert_eq!(
            err2,
            format!("Unix timestamp is out of range: {}", i64::MAX)
        );
        assert_eq!(err1, err2);
    }

    #[test]
    fn format_session_header_and_segment_timestamps_share_hour_minute_for_same_unix_secs() {
        // 1_713_333_045 = 2024-04-17 05:50:45 UTC。header の末尾 "05:50" と segment 先頭 "05:50" が一致する不変条件。
        let utc = FixedOffset::east_opt(0).unwrap();
        let header = format_session_header_timestamp_with_offset(1_713_333_045, utc).unwrap();
        let segment = format_segment_timestamp_with_offset(1_713_333_045, utc).unwrap();
        assert_eq!(header, "2024-04-17 05:50");
        assert_eq!(segment, "05:50:45");
        assert!(header.ends_with(&segment[..5]));
    }
}
