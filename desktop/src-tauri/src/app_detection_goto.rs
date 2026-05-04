use crate::app_detection::is_valid_dns_label;

const GOTO_NON_ROOM_PATHS: &[&str] = &[
    "about", "pricing", "blog", "login", "signup", "help", "terms", "privacy", "contact",
    "products", "features", "download", "app", "api", "security", "status",
];

/// GoToMeeting (GoTo Connect) は単一グローバルドメイン (`goto.com` / 旧 `gotomeeting.com`) で運用される。
/// GoTo 公式 Allowlist ドキュメント (support.goto.com/meeting/help/allowlisting-and-firewall-configuration)
/// はワイルドカード `*.goto.com` を推奨しており、データセンターはカリフォルニア/オレゴン/バージニア/
/// シンガポール/オーストラリア/日本に地理分散するが、URL 透過で load balancing されるため
/// EU/UK 等のリージョン専用 TLD (`app.goto.eu` / `app.goto.co.uk` 等) は 2026-05-05 時点で
/// 存在が確認できない。Webex / Whereby / Google Meet と同じ単一 TLD 方針であり、
/// 現在の 3 host pattern (meet.goto.com / app.goto.com / global.gotomeeting.com) で網羅完了とする。
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_goto_host_rejects_hypothetical_eu_tld() {
        assert!(!is_goto_host("app.goto.eu"));
    }

    #[test]
    fn is_goto_host_rejects_bare_goto_com_without_subdomain() {
        assert!(!is_goto_host("goto.com"));
    }
}
