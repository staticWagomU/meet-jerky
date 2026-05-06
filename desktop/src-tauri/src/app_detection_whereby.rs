//! Whereby ミーティング URL 検知ロジック (mjc-main-20260505-16 Loop 31 で抽出)。

use crate::app_detection_url_helpers::is_valid_dns_label;

const WHEREBY_NON_ROOM_PATHS: &[&str] = &[
    "about",
    "pricing",
    "blog",
    "login",
    "signup",
    "help",
    "terms",
    "privacy",
    "contact",
    "features",
    "customers",
    "embedded",
    "embed",
    "information",
    "api",
    "products",
    "integrations",
    "security",
    "careers",
    "status",
    "download",
    "app",
    "for-teams",
    "developers",
];

pub(crate) fn is_whereby_host(host: &str) -> bool {
    if host == "whereby.com" {
        return true;
    }
    let Some(subdomain) = host.strip_suffix(".whereby.com") else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

pub(crate) fn is_whereby_meeting_url(host: &str, path: &str) -> bool {
    if !is_whereby_host(host) {
        return false;
    }
    let Some(room) = path.strip_prefix('/') else {
        return false;
    };
    let room = room.strip_suffix('/').unwrap_or(room);
    !room.is_empty()
        && !room.contains('/')
        && !WHEREBY_NON_ROOM_PATHS
            .iter()
            .any(|non_room_path| non_room_path.eq_ignore_ascii_case(room))
}
