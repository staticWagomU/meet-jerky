use crate::app_detection_url_helpers::query_has_non_empty_param;
use crate::app_detection_url_helpers::{has_single_non_empty_segment, is_valid_dns_label};

pub(crate) fn is_webex_host(host: &str) -> bool {
    if host == "webex.com" {
        return true;
    }
    let Some(subdomain) = host.strip_suffix(".webex.com") else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

pub(crate) fn is_webex_meeting_url(host: &str, path: &str) -> bool {
    // Personal Room (`/meet/<id>`) / j.php 招待 URL (`/<site>/j.php?MTID=<token>`) /
    // wbxmjs Meeting Join Service URL (`/wbxmjs/joinservice/sites/<site>/meeting/...`) /
    // webappng URL (`/webappng/sites/<site>/meeting/info/<token>`) に対応。
    // 他の Webex URL 形式は誤検知防止のため将来課題。
    is_webex_host(host)
        && path
            .strip_prefix("/meet/")
            .is_some_and(has_single_non_empty_segment)
}

pub(crate) fn is_jphp_path(path: &str) -> bool {
    let path = path.strip_suffix('/').unwrap_or(path);
    let Some(inner) = path.strip_prefix('/') else {
        return false;
    };
    let Some((segment, tail)) = inner.split_once('/') else {
        return false;
    };
    !segment.is_empty() && tail == "j.php"
}

pub(crate) fn is_webex_jphp_meeting_url(host: &str, path: &str, query: Option<&str>) -> bool {
    is_webex_host(host) && is_jphp_path(path) && query_has_non_empty_param(query, "MTID")
}

pub(crate) fn is_wbxmjs_path(path: &str) -> bool {
    let path = if path.ends_with("//") {
        path
    } else {
        path.strip_suffix('/').unwrap_or(path)
    };
    let Some(rest) = path.strip_prefix("/wbxmjs/joinservice/sites/") else {
        return false;
    };
    let Some((site, after_site)) = rest.split_once('/') else {
        return false;
    };
    if site.is_empty() {
        return false;
    }
    let Some(after_meeting) = after_site.strip_prefix("meeting/") else {
        return false;
    };
    !after_meeting.is_empty() && after_meeting.split('/').all(|segment| !segment.is_empty())
}

pub(crate) fn is_webex_wbxmjs_meeting_url(host: &str, path: &str) -> bool {
    is_webex_host(host) && is_wbxmjs_path(path)
}

pub(crate) fn is_webappng_path(path: &str) -> bool {
    let path = if path.ends_with("//") {
        path
    } else {
        path.strip_suffix('/').unwrap_or(path)
    };
    let Some(rest) = path.strip_prefix("/webappng/sites/") else {
        return false;
    };
    let Some((site, after_site)) = rest.split_once('/') else {
        return false;
    };
    if site.is_empty() {
        return false;
    }
    let Some(after_meeting) = after_site.strip_prefix("meeting/") else {
        return false;
    };
    let Some((action, token)) = after_meeting.split_once('/') else {
        return false;
    };
    action == "info" && has_single_non_empty_segment(token)
}

pub(crate) fn is_webex_webappng_meeting_url(host: &str, path: &str) -> bool {
    is_webex_host(host) && is_webappng_path(path)
}
