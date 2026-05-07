//! Microsoft Teams URL 検知ロジック。
//!
//! `app_detection.rs` から Loop 43 で抽出 (Webex/Whereby/GoToMeeting/Zoom precedent 同パターン)。

use std::borrow::Cow;

/// Microsoft Teams 会議 URL を判定する。
///
/// 受理パターン (4 系統):
/// - work-or-school host (`teams.microsoft.com` / `teams.cloud.microsoft`) + `/l/meetup-join/<segment>/<segment...>`
/// - work-or-school host + path `/v2` または `/v2/` + query に `meetingjoin=true`
/// - work-or-school host + `/meet/<id>`
/// - `teams.live.com` + `/meet/<id>` (個人版)
pub(crate) fn is_teams_meeting_url(host: &str, path: &str, query: Option<&str>) -> bool {
    (is_teams_work_or_school_host(host)
        && path
            .strip_prefix("/l/meetup-join/")
            .is_some_and(has_at_least_two_non_empty_path_segments))
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

fn has_at_least_two_non_empty_path_segments(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    let mut segment_count = 0;

    for segment in value.split('/') {
        if segment.is_empty() {
            return false;
        }
        segment_count += 1;
    }

    segment_count >= 2
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_or_school_meetup_join_requires_at_least_two_non_empty_segments() {
        for host in ["teams.microsoft.com", "teams.cloud.microsoft"] {
            assert!(is_teams_meeting_url(
                host,
                "/l/meetup-join/19:meeting_thread/0",
                None,
            ));
            assert!(is_teams_meeting_url(
                host,
                "/l/meetup-join/19:meeting_thread/0/",
                None,
            ));

            assert!(!is_teams_meeting_url(host, "/l/meetup-join/", None));
            assert!(!is_teams_meeting_url(host, "/l/meetup-join/secret", None,));
            assert!(!is_teams_meeting_url(
                host,
                "/l/meetup-join/19:meeting_thread//0",
                None,
            ));
        }

        assert!(has_at_least_two_non_empty_path_segments(
            "19:meeting_thread/0"
        ));
        assert!(has_at_least_two_non_empty_path_segments(
            "19:meeting_thread/0/"
        ));
        assert!(!has_at_least_two_non_empty_path_segments(""));
        assert!(!has_at_least_two_non_empty_path_segments(
            "19:meeting_thread"
        ));
        assert!(!has_at_least_two_non_empty_path_segments(
            "19:meeting_thread//0"
        ));
    }

    #[test]
    fn work_or_school_v2_accepts_meetingjoin_true_query_variants() {
        for host in ["teams.microsoft.com", "teams.cloud.microsoft"] {
            assert!(is_teams_meeting_url(host, "/v2", Some("meetingjoin=true"),));
            assert!(is_teams_meeting_url(
                host,
                "/v2/",
                Some("context=abc&meetingjoin=true"),
            ));
            assert!(is_teams_meeting_url(
                host,
                "/v2",
                Some("meetingjoin=false&meetingjoin=true"),
            ));
            assert!(is_teams_meeting_url(
                host,
                "/v2",
                Some("%6d%65%65%74%69%6e%67%6a%6f%69%6e=%74%72%75%65"),
            ));
        }

        assert!(query_has_param(
            Some("context=abc&meetingjoin=true"),
            "meetingjoin",
            "true",
        ));
        assert!(query_has_param(
            Some("meetingjoin=false&meetingjoin=true"),
            "meetingjoin",
            "true",
        ));
        assert!(query_has_param(
            Some("%6d%65%65%74%69%6e%67%6a%6f%69%6e=%74%72%75%65"),
            "meetingjoin",
            "true",
        ));
    }

    #[test]
    fn work_or_school_v2_rejects_invalid_meetingjoin_query_variants() {
        for query in [
            "meetingjoin=tr%ZZue",
            "meetingjoin%3Dtrue",
            "meetingjoin=false",
            "meetingjoin",
        ] {
            assert!(!is_teams_meeting_url(
                "teams.microsoft.com",
                "/v2",
                Some(query),
            ));
            assert!(!query_has_param(Some(query), "meetingjoin", "true"));
        }
    }

    #[test]
    fn meet_path_requires_single_numeric_id_for_work_school_and_live_hosts() {
        for host in [
            "teams.microsoft.com",
            "teams.cloud.microsoft",
            "teams.live.com",
        ] {
            assert!(is_teams_meeting_url(host, "/meet/123456789", None));
            assert!(is_teams_meeting_url(host, "/meet/123456789/", None));

            assert!(!is_teams_meeting_url(host, "/meet/not-numeric", None));
            assert!(!is_teams_meeting_url(host, "/meet/123456789/extra", None));
            assert!(!is_teams_meeting_url(host, "/meet/", None));
        }

        assert!(has_single_numeric_meet_id_segment("123456789"));
        assert!(has_single_numeric_meet_id_segment("123456789/"));
        assert!(!has_single_numeric_meet_id_segment("not-numeric"));
        assert!(!has_single_numeric_meet_id_segment("123456789/extra"));
        assert!(!has_single_numeric_meet_id_segment(""));
    }

    #[test]
    fn live_host_rejects_work_or_school_only_paths() {
        assert!(!is_teams_meeting_url(
            "teams.live.com",
            "/l/meetup-join/19:meeting_thread/thread.v2",
            None,
        ));
        assert!(!is_teams_meeting_url(
            "teams.live.com",
            "/v2",
            Some("meetingjoin=true"),
        ));
    }
}
