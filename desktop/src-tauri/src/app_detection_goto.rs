use crate::app_detection::is_valid_dns_label;

const GOTO_NON_ROOM_PATHS: &[&str] = &[
    "about", "pricing", "blog", "login", "signup", "help", "terms", "privacy", "contact",
    "products", "features", "download", "app", "api", "security", "status",
];

pub(crate) fn is_goto_host(host: &str) -> bool {
    if host == "meet.goto.com" {
        return true;
    }
    let Some(subdomain) = host.strip_suffix(".meet.goto.com") else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

pub(crate) fn is_goto_meeting_url(host: &str, path: &str) -> bool {
    if !is_goto_host(host) {
        return false;
    }
    let Some(room) = path.strip_prefix('/') else {
        return false;
    };
    let room = room.strip_suffix('/').unwrap_or(room);
    !room.is_empty() && !room.contains('/') && !GOTO_NON_ROOM_PATHS.contains(&room)
}

pub(crate) fn is_goto_legacy_meeting_url(host: &str, path: &str) -> bool {
    if host != "global.gotomeeting.com" {
        return false;
    }
    let Some(id) = path.strip_prefix("/join/") else {
        return false;
    };
    let id = id.strip_suffix('/').unwrap_or(id);
    id.len() == 9 && id.chars().all(|c| c.is_ascii_digit())
}

pub(crate) fn is_goto_app_meeting_url(host: &str, path: &str) -> bool {
    if host != "app.goto.com" {
        return false;
    }
    let Some(id) = path.strip_prefix("/meet/") else {
        return false;
    };
    let id = id.strip_suffix('/').unwrap_or(id);
    id.len() == 9 && id.chars().all(|c| c.is_ascii_digit())
}
