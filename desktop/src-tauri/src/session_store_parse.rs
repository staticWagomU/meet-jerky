//! セッション ID パース・markdown unescape の純粋ヘルパー。

const MAX_JS_DATE_UNIX_SECS: u64 = 8_640_000_000_000;

pub(crate) fn unescape_inline_markdown_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek().copied() {
                Some('\\' | '`' | '*' | '_' | '[' | ']') => {
                    if let Some(escaped) = chars.next() {
                        out.push(escaped);
                    }
                }
                _ => out.push(ch),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

pub(crate) fn parse_session_started_at_secs(stem: &str) -> Option<u64> {
    let prefix = stem.split('-').next().unwrap_or("");
    let started_at_secs = prefix.parse::<u64>().ok()?;
    if started_at_secs > MAX_JS_DATE_UNIX_SECS {
        return None;
    }
    Some(started_at_secs)
}
