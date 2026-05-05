//! Microsoft Teams URL 検知ロジック。
//!
//! `app_detection.rs` から Loop 43 で抽出 (Webex/Whereby/GoToMeeting/Zoom precedent 同パターン)。

use crate::app_detection_url_helpers::has_single_non_empty_segment;

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
                .is_some_and(has_single_non_empty_segment))
        || (host == "teams.live.com"
            && path
                .strip_prefix("/meet/")
                .is_some_and(has_single_non_empty_segment))
}

fn is_teams_work_or_school_host(host: &str) -> bool {
    host == "teams.microsoft.com" || host == "teams.cloud.microsoft"
}

fn has_non_empty_path_segments(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    !value.is_empty() && value.split('/').all(|segment| !segment.is_empty())
}

fn query_has_param(query: Option<&str>, key: &str, value: &str) -> bool {
    query.is_some_and(|query| {
        query.split('&').any(|param| {
            let (param_key, param_value) = param.split_once('=').unwrap_or((param, ""));
            param_key.eq_ignore_ascii_case(key) && param_value.eq_ignore_ascii_case(value)
        })
    })
}
