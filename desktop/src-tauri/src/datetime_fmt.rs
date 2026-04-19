//! Unix時刻（秒）を、Markdown出力に使う表示文字列へ整形するユーティリティ。
//!
//! TDDのため、テスト可能な `*_with_offset` 関数を公開する。
//! プロダクション側のローカルタイム用ラッパーは別途追加予定。

use chrono::{DateTime, FixedOffset, TimeZone};

/// セッションヘッダ用のタイムスタンプ（`YYYY-MM-DD HH:MM`）を指定オフセットで整形する。
pub fn format_session_header_timestamp_with_offset(unix_secs: i64, offset: FixedOffset) -> String {
    let dt: DateTime<FixedOffset> = offset.timestamp_opt(unix_secs, 0).unwrap();
    dt.format("%Y-%m-%d %H:%M").to_string()
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
        let s = format_session_header_timestamp_with_offset(1_713_333_000, jst());
        assert_eq!(s, "2024-04-17 14:50");
    }
}
