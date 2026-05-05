//! URL 検知用の汎用 helper 関数群。
//!
//! RFC 1035/1123 に基づく DNS label 妥当性検証と、path segment 単一性検証、
//! および URL 全体 (host/path/query) の parse helper を提供する。
//! goto/teams/webex/whereby/zoom の各 service module から直接 import して使用する。

pub(crate) fn is_valid_dns_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        && bytes
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
}

pub(crate) fn has_single_non_empty_segment(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    !value.is_empty() && !value.contains('/')
}

pub(crate) fn normalize_url_host(host: &str) -> Option<String> {
    let normalized = host.to_ascii_lowercase();
    let normalized = normalized.strip_suffix('.').unwrap_or(&normalized);
    if normalized.is_empty() || normalized.ends_with('.') {
        return None;
    }
    Some(normalized.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedUrlParts {
    pub(crate) host: String,
    pub(crate) path: String,
    pub(crate) query: Option<String>,
}

pub(crate) fn parse_url_host_and_path(url: &str) -> Option<ParsedUrlParts> {
    let trimmed = url.trim();
    if trimmed.chars().any(char::is_whitespace) {
        return None;
    }

    let (scheme, after_scheme) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }

    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.contains('@') {
        return None;
    }
    let host_port = authority;
    let host = strip_port(host_port)?;
    if host.is_empty() {
        return None;
    }

    let path =
        if authority_end < after_scheme.len() && after_scheme[authority_end..].starts_with('/') {
            let rest = &after_scheme[authority_end..];
            let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
            rest[..path_end].to_string()
        } else {
            "/".to_string()
        };
    let query = extract_query(&after_scheme[authority_end..]);

    Some(ParsedUrlParts {
        host: host.to_string(),
        path,
        query,
    })
}

pub(crate) fn extract_query(rest: &str) -> Option<String> {
    let query_start = rest.find('?')?;
    if let Some(fragment_start) = rest.find('#') {
        if fragment_start < query_start {
            return None;
        }
    }
    let query = &rest[query_start + 1..];
    let query_end = query.find('#').unwrap_or(query.len());
    Some(query[..query_end].to_string())
}

pub(crate) fn strip_port(host_port: &str) -> Option<&str> {
    if let Some(without_opening_bracket) = host_port.strip_prefix('[') {
        let (host, port) = without_opening_bracket.split_once(']')?;
        if !host.contains(':') {
            return None;
        }
        if let Some(port) = port.strip_prefix(':') {
            validate_port(port)?;
        } else if !port.is_empty() {
            return None;
        }
        return Some(host);
    }

    if let Some((host, port)) = host_port.split_once(':') {
        validate_port(port)?;
        Some(host)
    } else {
        Some(host_port)
    }
}

pub(crate) fn validate_port(port: &str) -> Option<()> {
    if port.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    Some(())
}

pub(crate) fn query_has_non_empty_param(query: Option<&str>, key: &str) -> bool {
    query.is_some_and(|query| {
        query.split('&').any(|param| {
            let (param_key, param_value) = param.split_once('=').unwrap_or((param, ""));
            param_key.eq_ignore_ascii_case(key) && !param_value.is_empty()
        })
    })
}
