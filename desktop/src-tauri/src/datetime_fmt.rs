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
}
