//! セッションをMarkdown形式に整形する純粋関数を提供するモジュール。
//!
//! Phase 5 TDD: ファイルI/Oやストレージは含まない。フォーマッタのみ。

/// Markdown出力のメタデータ。
///
/// `started_at_display` は呼び出し側でローカルタイムゾーンを考慮して整形した文字列
/// （例: "2026-04-17 14:30"）。フォーマッタに時刻計算の責務を持たせない。
pub struct SessionMeta {
    pub title: String,
    pub started_at_display: String,
}

/// Markdown出力のための1セグメント。
///
/// `timestamp_display` は呼び出し側が整形した文字列（例: "14:30:05"）。
pub struct SessionSegment {
    pub speaker: String,
    pub timestamp_display: String,
    pub text: String,
}

/// セッションをMarkdown形式の文字列に整形する。
pub fn format_session_markdown(meta: &SessionMeta, segments: &[SessionSegment]) -> String {
    let mut out = format!("# {} - {}\n\n", meta.title, meta.started_at_display);
    let lines: Vec<String> = segments
        .iter()
        .map(|s| format!("**[{}] {}:** {}", s.timestamp_display, s.speaker, s.text))
        .collect();
    out.push_str(&lines.join("\n"));
    out
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_session_markdown_happy_path() {
        let meta = SessionMeta {
            title: "会議メモ".to_string(),
            started_at_display: "2026-04-17 14:30".to_string(),
        };
        let segments = vec![
            SessionSegment {
                speaker: "相手".to_string(),
                timestamp_display: "14:30:05".to_string(),
                text: "それでは始めましょう。".to_string(),
            },
            SessionSegment {
                speaker: "自分".to_string(),
                timestamp_display: "14:30:12".to_string(),
                text: "よろしくお願いします。".to_string(),
            },
        ];

        let expected = "# 会議メモ - 2026-04-17 14:30\n\n**[14:30:05] 相手:** それでは始めましょう。\n**[14:30:12] 自分:** よろしくお願いします。";
        assert_eq!(format_session_markdown(&meta, &segments), expected);
    }
}
