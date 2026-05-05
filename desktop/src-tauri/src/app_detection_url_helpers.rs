//! URL 検知用の汎用 helper 関数群。
//!
//! RFC 1035/1123 に基づく DNS label 妥当性検証と、path segment 単一性検証を提供する。
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
