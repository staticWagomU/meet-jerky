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
    let header = format!(
        "# {} - {}\n",
        inline_markdown_text(&meta.title),
        inline_markdown_text(&meta.started_at_display)
    );
    if segments.is_empty() {
        return header;
    }

    let mut out = header;
    out.push('\n');
    let lines: Vec<String> = segments
        .iter()
        .map(|s| {
            format!(
                "**[{}] {}:** {}  ",
                inline_markdown_text(&s.timestamp_display),
                inline_markdown_text(&s.speaker),
                inline_markdown_text(&s.text)
            )
        })
        .collect();
    out.push_str(&lines.join("\n"));
    out
}

fn inline_markdown_text(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut escaped = String::with_capacity(normalized.len());
    for ch in normalized.chars() {
        if matches!(ch, '\\' | '`' | '*' | '_' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
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
                speaker: "相手側".to_string(),
                timestamp_display: "14:30:05".to_string(),
                text: "それでは始めましょう。".to_string(),
            },
            SessionSegment {
                speaker: "自分".to_string(),
                timestamp_display: "14:30:12".to_string(),
                text: "よろしくお願いします。".to_string(),
            },
        ];

        let expected = "# 会議メモ - 2026-04-17 14:30\n\n**[14:30:05] 相手側:** それでは始めましょう。  \n**[14:30:12] 自分:** よろしくお願いします。  ";
        assert_eq!(format_session_markdown(&meta, &segments), expected);
    }

    #[test]
    fn test_format_session_markdown_empty_segments_produces_header_only() {
        // セグメントが空の場合、ヘッダのみを出力し、末尾に余分な空行やセグメント行を付けない。
        let meta = SessionMeta {
            title: "会議メモ".to_string(),
            started_at_display: "2026-04-17 14:30".to_string(),
        };
        let segments: Vec<SessionSegment> = Vec::new();

        let expected = "# 会議メモ - 2026-04-17 14:30\n";
        assert_eq!(format_session_markdown(&meta, &segments), expected);
    }

    #[test]
    fn test_format_session_markdown_normalizes_inline_newlines() {
        let meta = SessionMeta {
            title: "会議\nメモ".to_string(),
            started_at_display: "2026-04-17 14:30".to_string(),
        };
        let segments = vec![SessionSegment {
            speaker: "自分\n側".to_string(),
            timestamp_display: "14:30:05".to_string(),
            text: "1行目\n2行目\t3行目".to_string(),
        }];

        let expected =
            "# 会議 メモ - 2026-04-17 14:30\n\n**[14:30:05] 自分 側:** 1行目 2行目 3行目  ";
        assert_eq!(format_session_markdown(&meta, &segments), expected);
    }

    #[test]
    fn test_format_session_markdown_escapes_inline_markdown_marks() {
        let meta = SessionMeta {
            title: "会議 *重要*".to_string(),
            started_at_display: "2026-04-17 14:30".to_string(),
        };
        let segments = vec![SessionSegment {
            speaker: "自分[メモ]".to_string(),
            timestamp_display: "14:30:05".to_string(),
            text: r#"literal `code` and **bold** \ slash"#.to_string(),
        }];

        let expected = r#"# 会議 \*重要\* - 2026-04-17 14:30

**[14:30:05] 自分\[メモ\]:** literal \`code\` and \*\*bold\*\* \\ slash  "#;
        assert_eq!(format_session_markdown(&meta, &segments), expected);
    }

    #[test]
    fn inline_markdown_text_returns_empty_for_empty_input() {
        assert_eq!(super::inline_markdown_text(""), "");
    }

    #[test]
    fn inline_markdown_text_returns_empty_for_whitespace_only_input() {
        assert_eq!(super::inline_markdown_text("   "), "");
        assert_eq!(super::inline_markdown_text("\t\n  "), "");
        assert_eq!(super::inline_markdown_text(" \t \n "), "");
    }

    #[test]
    fn inline_markdown_text_escapes_underscore_explicitly() {
        assert_eq!(super::inline_markdown_text("_"), "\\_");
        assert_eq!(super::inline_markdown_text("hello_world"), "hello\\_world");
        assert_eq!(super::inline_markdown_text("__bold__"), "\\_\\_bold\\_\\_");
    }

    #[test]
    fn inline_markdown_text_escapes_each_special_char_individually() {
        assert_eq!(super::inline_markdown_text("\\"), "\\\\");
        assert_eq!(super::inline_markdown_text("`"), "\\`");
        assert_eq!(super::inline_markdown_text("*"), "\\*");
        assert_eq!(super::inline_markdown_text("_"), "\\_");
        assert_eq!(super::inline_markdown_text("["), "\\[");
        assert_eq!(super::inline_markdown_text("]"), "\\]");
    }

    #[test]
    fn format_session_markdown_handles_single_segment_correctly() {
        let meta = SessionMeta {
            title: "会議".to_string(),
            started_at_display: "2026-04-17 14:30".to_string(),
        };
        let segments = vec![SessionSegment {
            speaker: "自分".to_string(),
            timestamp_display: "14:30:05".to_string(),
            text: "hello".to_string(),
        }];

        let expected = "# 会議 - 2026-04-17 14:30\n\n**[14:30:05] 自分:** hello  ";
        assert_eq!(format_session_markdown(&meta, &segments), expected);
    }

    #[test]
    fn format_session_markdown_joins_three_or_more_segments_with_single_newline_between() {
        let meta = SessionMeta {
            title: "会議".to_string(),
            started_at_display: "2026-04-17 14:30".to_string(),
        };
        let segments = vec![
            SessionSegment {
                speaker: "A".to_string(),
                timestamp_display: "14:30:01".to_string(),
                text: "first".to_string(),
            },
            SessionSegment {
                speaker: "B".to_string(),
                timestamp_display: "14:30:02".to_string(),
                text: "second".to_string(),
            },
            SessionSegment {
                speaker: "C".to_string(),
                timestamp_display: "14:30:03".to_string(),
                text: "third".to_string(),
            },
        ];

        let expected = "# 会議 - 2026-04-17 14:30\n\n**[14:30:01] A:** first  \n**[14:30:02] B:** second  \n**[14:30:03] C:** third  ";
        assert_eq!(format_session_markdown(&meta, &segments), expected);

        let result = format_session_markdown(&meta, &segments);
        let pos_a = result.find("first").unwrap();
        let pos_b = result.find("second").unwrap();
        let pos_c = result.find("third").unwrap();
        assert!(
            pos_a < pos_b && pos_b < pos_c,
            "segment 順序が出力に保たれる契約"
        );
    }

    #[test]
    fn format_session_markdown_escapes_special_chars_in_started_at_display_and_timestamp_display() {
        let meta = SessionMeta {
            title: "title".to_string(),
            started_at_display: "*2026*_04_[17]".to_string(),
        };
        let segments = vec![SessionSegment {
            speaker: "speaker".to_string(),
            timestamp_display: "[14:30:05]".to_string(),
            text: "text".to_string(),
        }];

        let result = format_session_markdown(&meta, &segments);

        assert!(
            result.contains("\\*2026\\*\\_04\\_\\[17\\]"),
            "started_at_display も escape される契約: result=\n{result}"
        );
        assert!(
            result.contains("\\[14:30:05\\]"),
            "timestamp_display も escape される契約: result=\n{result}"
        );
    }

    #[test]
    fn inline_markdown_text_escapes_each_char_in_consecutive_or_mixed_special_runs() {
        assert_eq!(super::inline_markdown_text("***"), "\\*\\*\\*");
        assert_eq!(super::inline_markdown_text("[[]]"), "\\[\\[\\]\\]");
        assert_eq!(super::inline_markdown_text("\\\\\\"), "\\\\\\\\\\\\");
        assert_eq!(super::inline_markdown_text("*_*"), "\\*\\_\\*");
        assert_eq!(super::inline_markdown_text("[`code`]"), "\\[\\`code\\`\\]");
    }

    #[test]
    fn inline_markdown_text_passes_through_emoji_combining_and_zwj_chars_without_escape() {
        assert_eq!(super::inline_markdown_text("🎉"), "🎉");
        assert_eq!(super::inline_markdown_text("hello🎉world"), "hello🎉world");
        let combining = "e\u{0301}";
        assert_eq!(super::inline_markdown_text(combining), combining);
        let zwj_family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        assert_eq!(super::inline_markdown_text(zwj_family), zwj_family);
        assert_eq!(super::inline_markdown_text("「重要」※"), "「重要」※");
    }

    #[test]
    fn inline_markdown_text_treats_full_width_space_and_nbsp_as_split_whitespace() {
        assert_eq!(super::inline_markdown_text("a\u{3000}b"), "a b");
        assert_eq!(super::inline_markdown_text("a\u{00A0}b"), "a b");
        assert_eq!(super::inline_markdown_text("a\u{2028}b"), "a b");
        assert_eq!(super::inline_markdown_text("x \u{00A0}\u{3000}\ty"), "x y");
        assert_eq!(super::inline_markdown_text("\u{3000}\u{3000}\u{3000}"), "");
    }
}
