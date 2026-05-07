use crate::app_detection_url_helpers::has_single_non_empty_segment;

pub(crate) fn is_google_meet_url(host: &str, path: &str) -> bool {
    host == "meet.google.com"
        && (is_google_meet_code_path(path)
            || is_google_meet_landing_code_path(path)
            || path
                .strip_prefix("/lookup/")
                .is_some_and(has_single_non_empty_segment))
}

pub(crate) fn is_google_meet_code_path(path: &str) -> bool {
    let Some(code) = path.strip_prefix('/') else {
        return false;
    };
    let code = code.strip_suffix('/').unwrap_or(code);

    let mut parts = code.split('-');
    let (Some(first), Some(second), Some(third), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    has_ascii_lowercase_len(first, 3)
        && has_ascii_lowercase_len(second, 4)
        && has_ascii_lowercase_len(third, 3)
}

fn has_ascii_lowercase_len(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte: u8| byte.is_ascii_lowercase())
}

fn is_google_meet_landing_code_path(path: &str) -> bool {
    let Some(code) = path.strip_prefix("/landing/") else {
        return false;
    };
    let code_path = format!("/{code}");

    is_google_meet_code_path(&code_path)
}
