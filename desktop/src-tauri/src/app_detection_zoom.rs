use crate::app_detection_url_helpers::{has_single_non_empty_segment, is_valid_dns_label};

pub(crate) fn is_zoom_host(host: &str) -> bool {
    if host == "zoom.us" || host == "zoomgov.com" {
        return true;
    }

    let subdomain = if let Some(subdomain) = host.strip_suffix(".zoom.us") {
        subdomain
    } else if let Some(subdomain) = host.strip_suffix(".zoomgov.com") {
        subdomain
    } else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

pub(crate) fn is_zoom_meeting_url(host: &str, path: &str) -> bool {
    is_zoom_host(host)
        && (path.strip_prefix("/j/").is_some_and(is_zoom_meeting_id)
            || path
                .strip_prefix("/wc/join/")
                .is_some_and(is_zoom_meeting_id)
            || is_zoom_web_client_meeting_url(path)
            || path
                .strip_prefix("/my/")
                .is_some_and(has_single_non_empty_segment))
}

fn is_zoom_meeting_id(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    (9..=11).contains(&value.len()) && value.bytes().all(|byte: u8| byte.is_ascii_digit())
}

fn is_zoom_web_client_meeting_url(path: &str) -> bool {
    let Some(value) = path.strip_prefix("/wc/") else {
        return false;
    };
    let value = value.strip_suffix('/').unwrap_or(value);
    let Some((meeting_id, action)) = value.split_once('/') else {
        return false;
    };
    matches!(action, "join" | "start") && is_zoom_meeting_id(meeting_id)
}
