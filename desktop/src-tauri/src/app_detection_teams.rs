//! Microsoft Teams URL 検知ロジック。
//!
//! `app_detection.rs` から Loop 43 で抽出 (Webex/Whereby/GoToMeeting/Zoom precedent 同パターン)。

use std::borrow::Cow;

/// Microsoft Teams 会議 URL を判定する。
///
/// 受理パターン (4 系統):
/// - work-or-school host (`teams.microsoft.com` / `teams.cloud.microsoft`) + `/l/meetup-join/<segments>`
/// - work-or-school host + path `/v2` または `/v2/` + query に `meetingjoin=true`
/// - work-or-school host + `/meet/<id>`
/// - `teams.live.com` + `/meet/<id>` (個人版)
pub(crate) fn is_teams_meeting_url(host: &str, path: &str, query: Option<&str>) -> bool {
    (is_teams_work_or_school_host(host)
        && path
            .strip_prefix("/l/meetup-join/")
            .is_some_and(has_non_empty_path_segments))
        || (is_teams_work_or_school_host(host)
            && (path == "/v2" || path == "/v2/")
            && query_has_param(query, "meetingjoin", "true"))
        || (is_teams_work_or_school_host(host)
            && path
                .strip_prefix("/meet/")
                .is_some_and(has_single_numeric_meet_id_segment))
        || (host == "teams.live.com"
            && path
                .strip_prefix("/meet/")
                .is_some_and(has_single_numeric_meet_id_segment))
}

fn is_teams_work_or_school_host(host: &str) -> bool {
    host == "teams.microsoft.com" || host == "teams.cloud.microsoft"
}

fn has_non_empty_path_segments(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    !value.is_empty() && value.split('/').all(|segment| !segment.is_empty())
}

fn has_single_numeric_meet_id_segment(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    !value.is_empty() && !value.contains('/') && value.chars().all(|ch| ch.is_ascii_digit())
}

fn query_has_param(query: Option<&str>, key: &str, value: &str) -> bool {
    query.is_some_and(|query| {
        query.split('&').any(|param| {
            let (param_key, param_value) = param.split_once('=').unwrap_or((param, ""));
            decoded_ascii_component_eq_ignore_case(param_key, key)
                && decoded_ascii_component_eq_ignore_case(param_value, value)
        })
    })
}

fn decoded_ascii_component_eq_ignore_case(component: &str, expected: &str) -> bool {
    percent_decode_ascii_component(component)
        .is_some_and(|decoded| decoded.eq_ignore_ascii_case(expected))
}

fn percent_decode_ascii_component(component: &str) -> Option<Cow<'_, str>> {
    if !component.as_bytes().contains(&b'%') {
        return Some(Cow::Borrowed(component));
    }

    let bytes = component.as_bytes();
    let mut decoded = String::with_capacity(component.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            let byte = hex_value(high)? * 16 + hex_value(low)?;
            if !byte.is_ascii() {
                return None;
            }
            decoded.push(char::from(byte));
            index += 3;
        } else {
            let ch = component[index..].chars().next()?;
            decoded.push(ch);
            index += ch.len_utf8();
        }
    }

    Some(Cow::Owned(decoded))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
