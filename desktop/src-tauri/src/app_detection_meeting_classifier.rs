//! 会議サービス分類用の純粋関数群。
//!
//! ブラウザの URL またはウィンドウタイトルを受け取り、Google Meet / Zoom / Webex /
//! Whereby / GoToMeeting / Microsoft Teams のいずれかに分類する。
//! `app_detection_url_helpers` の低レベル URL parser と各 service module
//! (`app_detection_google_meet` / `app_detection_zoom` 等) を上位レイヤーで組み合わせる。

use crate::app_detection::MeetingUrlClassification;
use crate::app_detection_url_helpers::{normalize_url_host, parse_url_host_and_path};

/// ブラウザ URL の実機取得が入った後に使う、会議 URL 分類用の純粋関数。
///
/// 標準文字列処理だけで host/path/query を見て分類し、URL 全文は返さない。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn classify_meeting_url(url: &str) -> Option<MeetingUrlClassification> {
    let parsed = parse_url_host_and_path(url)?;
    let host = normalize_url_host(&parsed.host)?;

    let service = if crate::app_detection_google_meet::is_google_meet_url(&host, &parsed.path) {
        "Google Meet"
    } else if crate::app_detection_zoom::is_zoom_meeting_url(&host, &parsed.path) {
        "Zoom"
    } else if crate::app_detection_webex::is_webex_meeting_url(&host, &parsed.path)
        || crate::app_detection_webex::is_webex_jphp_meeting_url(
            &host,
            &parsed.path,
            parsed.query.as_deref(),
        )
        || crate::app_detection_webex::is_webex_wbxmjs_meeting_url(&host, &parsed.path)
        || crate::app_detection_webex::is_webex_webappng_meeting_url(&host, &parsed.path)
    {
        "Webex"
    } else if crate::app_detection_whereby::is_whereby_meeting_url(&host, &parsed.path) {
        "Whereby"
    } else if crate::app_detection_goto::is_goto_meeting_url(&host, &parsed.path)
        || crate::app_detection_goto::is_goto_legacy_meeting_url(&host, &parsed.path)
        || crate::app_detection_goto::is_goto_app_meeting_url(&host, &parsed.path)
    {
        "GoToMeeting"
    } else if crate::app_detection_teams::is_teams_meeting_url(
        &host,
        &parsed.path,
        parsed.query.as_deref(),
    ) {
        "Microsoft Teams"
    } else {
        return None;
    };

    Some(MeetingUrlClassification {
        service: service.to_string(),
        host,
    })
}

/// ブラウザのウィンドウタイトルから会議サービスを分類する純粋関数。
///
/// `classify_meeting_url` が `None` を返した場合 (URL 空・`about:blank`・AppleScript
/// 権限不足等) のフォールバックとして `handle_browser_url_detection` 内で使う。
///
/// 戻り値は [`MeetingUrlClassification`] を再利用するが、`host` フィールドは URL ホスト名
/// ではなく **空文字 `""`** を返す。window title 由来であることは呼び出し側の throttle_key
/// (`"window-title:{bundle_id}:{service}"` 形式) で区別する。
///
/// # 分類ルール (厳格・誤検知防止を優先)
///
/// - **Google Meet**: `"Meet - "` / `"Meet – "` (U+2013) / `"Meet — "` (U+2014) で始まり、
///   続く会議コードまたは名前が trim 後に非空のもの。Chrome/Safari/Edge のタブタイトルを想定。
///   `"Google Meet - "` / `"Google Meet – "` / `"Google Meet — "` は、続く文字列が
///   `aaa-bbbb-ccc` 形式の会議コードと完全一致する場合だけ対象にする。
/// - **Zoom**: `"Zoom Meeting"` または `"Zoom ミーティング"` と一致するか、その直後が
///   空白・括弧・改行等の区切り文字で始まるもの。
///   デスクトップアプリのウィンドウタイトルを想定。prefix の最小境界を見て
///   `"Zoom について - Wikipedia"` のような単語含みによる誤検知を防ぐ。
/// - **Webex**: `"Webex Meeting"` または `"Webex ミーティング"` と一致するか、その直後が
///   空白・パイプ等の区切り文字で始まるもの。ブラウザタブタイトルを想定。
/// - **Microsoft Teams**: ブラウザ版のタイトルパターン (`"Microsoft Teams"` suffix 等) は
///   外部チュートリアルや解説ページと区別できないため今回は fallback 対象外とする。
///   Teams はデスクトップアプリ (Bundle ID: `com.microsoft.teams2`) 経由で検知される。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn classify_meeting_window_title(window_title: &str) -> Option<MeetingUrlClassification> {
    // Google Meet のタブタイトルは Chrome/Safari/Edge とも "Meet - <code or name>" 形式。
    // ASCII ハイフン・en-dash (U+2013)・em-dash (U+2014) の3種をカバーし、
    // 続く名前が空白だけ ("Meet -  " 等) の場合は会議ではないとして除外する。
    let google_meet_detected =
        ["Meet - ", "Meet \u{2013} ", "Meet \u{2014} "]
            .iter()
            .any(|prefix| {
                window_title
                    .strip_prefix(prefix)
                    .is_some_and(is_non_empty_control_free_title_suffix)
            })
            || [
                "Google Meet - ",
                "Google Meet \u{2013} ",
                "Google Meet \u{2014} ",
            ]
            .iter()
            .any(|prefix| {
                window_title.strip_prefix(prefix).is_some_and(|rest| {
                    is_control_free_title_suffix(rest) && is_google_meet_code_title_suffix(rest)
                })
            });
    if google_meet_detected {
        return Some(MeetingUrlClassification {
            service: "Google Meet".to_string(),
            host: String::new(),
        });
    }

    // Zoom デスクトップアプリのウィンドウタイトルは "Zoom Meeting" / "Zoom ミーティング"
    // で始まる。参加者名や状態は区切り文字つき suffix として許可するが、
    // "Zoom Meetings Help" や "Zoom MeetingTools" のような単語連結は誤検知として除外する。
    if has_zoom_meeting_title_prefix(window_title, "Zoom Meeting")
        || has_zoom_meeting_title_prefix(window_title, "Zoom ミーティング")
    {
        return Some(MeetingUrlClassification {
            service: "Zoom".to_string(),
            host: String::new(),
        });
    }

    // Webex のブラウザタブタイトルは "Webex Meeting" / "Webex ミーティング"
    // で始まる。会社名などは区切り文字つき suffix として許可するが、
    // "Webex Meetings Help" や "Webex MeetingTools" のような単語連結は誤検知として除外する。
    if has_webex_meeting_title_prefix(window_title, "Webex Meeting")
        || has_webex_meeting_title_prefix(window_title, "Webex ミーティング")
    {
        return Some(MeetingUrlClassification {
            service: "Webex".to_string(),
            host: String::new(),
        });
    }

    None
}

fn has_zoom_meeting_title_prefix(window_title: &str, prefix: &str) -> bool {
    let Some(rest) = window_title.strip_prefix(prefix) else {
        return false;
    };

    rest.chars().next().is_none_or(|c| !c.is_alphanumeric())
}

fn has_webex_meeting_title_prefix(window_title: &str, prefix: &str) -> bool {
    let Some(rest) = window_title.strip_prefix(prefix) else {
        return false;
    };

    rest.chars().next().is_none_or(|c| !c.is_alphanumeric())
}

fn is_google_meet_code_title_suffix(value: &str) -> bool {
    let mut parts = value.split('-');
    let (Some(first), Some(second), Some(third), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    has_ascii_lowercase_len(first, 3)
        && has_ascii_lowercase_len(second, 4)
        && has_ascii_lowercase_len(third, 3)
}

fn is_non_empty_control_free_title_suffix(value: &str) -> bool {
    !value.trim().is_empty() && is_control_free_title_suffix(value)
}

fn is_control_free_title_suffix(value: &str) -> bool {
    !value
        .chars()
        .any(|c| matches!(c, '\u{0000}'..='\u{001F}' | '\u{007F}'))
}

fn has_ascii_lowercase_len(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_lowercase())
}
