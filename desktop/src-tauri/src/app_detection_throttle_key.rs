//! `last_seen_secs` HashMap の throttle_key を会議アプリ表示名に解釈する純粋関数。
//!
//! 3 つの key 形式 (アプリ経路 = bundle_id 単独 / browser 経路 = `"browser:..."` /
//! window-title 経路 = `"window-title:..."`) を文字列パターンマッチングで分解し、
//! 表示名 (Zoom / Google Meet 等) に変換する。
//! `app_detection_url_helpers` の URL parser や `app_detection_meeting_classifier`
//! の service 分類とは責務階層が異なる (key string 分解 vs URL/title 構造解析)。

use crate::app_detection::WATCHED_BUNDLE_IDS;

/// throttle_key を会議アプリ表示名に変換する純粋関数。
///
/// `last_seen_secs` HashMap に格納される 3 つの key 形式を解釈する:
/// - **アプリ経路 (handle_detection)**: bundle_id 単独 (例: `"us.zoom.xos"`) → `WATCHED_BUNDLE_IDS` lookup で `Some("Zoom")`
/// - **browser 経路**: `"browser:<bundle_id>:<service>:<host>"` → 3 つ目のセグメント (service) を `Some` で返す
/// - **window-title 経路**: `"window-title:<bundle_id>:<service>"` → 3 つ目のセグメント (service) を `Some` で返す
/// - 上記いずれにも該当しない不正形式・未知 bundle_id は `None` を返す
///
/// `check_all_inactive_bundles` の iteration で `last_seen_secs` の key 全件巡回時に
/// display name を解決するために呼ばれる。
pub(crate) fn parse_throttle_key_to_display_name(key: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix("browser:") {
        // "browser:<bundle_id>:<service>:<host>" → splitn(3, ':') → [bundle_id, service, host]
        let parts: Vec<&str> = rest.splitn(3, ':').collect();
        if parts.len() < 2 {
            return None;
        }
        let service = parts[1];
        if service.is_empty() {
            return None;
        }
        return Some(service.to_string());
    }
    if let Some(rest) = key.strip_prefix("window-title:") {
        // "window-title:<bundle_id>:<service>" → splitn(2, ':') → [bundle_id, service]
        let parts: Vec<&str> = rest.splitn(2, ':').collect();
        if parts.len() < 2 {
            return None;
        }
        let service = parts[1];
        if service.is_empty() {
            return None;
        }
        return Some(service.to_string());
    }
    // アプリ経路: bundle_id 単独 → WATCHED_BUNDLE_IDS lookup
    WATCHED_BUNDLE_IDS
        .iter()
        .find(|(bundle_id, _, _)| *bundle_id == key)
        .map(|(_, app_name, _)| app_name.to_string())
}
