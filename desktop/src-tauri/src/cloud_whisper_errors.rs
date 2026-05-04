#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudWhisperError {
    InvalidApiKey,
    RateLimited,
    ServerError,
    Other { status: u16, message: String },
}

#[allow(dead_code)]
pub fn classify_cloud_whisper_error(status: u16, body: &str) -> CloudWhisperError {
    match status {
        401 => CloudWhisperError::InvalidApiKey,
        429 => CloudWhisperError::RateLimited,
        500..=599 => CloudWhisperError::ServerError,
        _ => CloudWhisperError::Other {
            status,
            message: sanitize_error_body(body),
        },
    }
}

const MAX_ERROR_BODY_CHARS: usize = 200;

fn sanitize_error_body(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let was_truncated = normalized.chars().count() > MAX_ERROR_BODY_CHARS;
    let sanitized: String = normalized.chars().take(MAX_ERROR_BODY_CHARS).collect();

    if sanitized.is_empty() {
        "HTTP error body was empty".to_string()
    } else if was_truncated {
        format!("{sanitized}...")
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_401_returns_invalid_api_key() {
        assert_eq!(
            classify_cloud_whisper_error(401, "some body"),
            CloudWhisperError::InvalidApiKey
        );
    }

    #[test]
    fn classify_429_returns_rate_limited() {
        assert_eq!(
            classify_cloud_whisper_error(429, ""),
            CloudWhisperError::RateLimited
        );
    }

    #[test]
    fn classify_server_and_other_errors() {
        assert_eq!(
            classify_cloud_whisper_error(500, ""),
            CloudWhisperError::ServerError
        );
        assert_eq!(
            classify_cloud_whisper_error(599, ""),
            CloudWhisperError::ServerError
        );
        assert_eq!(
            classify_cloud_whisper_error(400, "bad request body"),
            CloudWhisperError::Other {
                status: 400,
                message: "bad request body".to_string(),
            }
        );
    }

    #[test]
    fn classify_other_error_sanitizes_body() {
        assert_eq!(
            classify_cloud_whisper_error(400, "  first line\n\tsecond line  "),
            CloudWhisperError::Other {
                status: 400,
                message: "first line second line".to_string(),
            }
        );
        assert_eq!(
            classify_cloud_whisper_error(418, ""),
            CloudWhisperError::Other {
                status: 418,
                message: "HTTP error body was empty".to_string(),
            }
        );

        let long_body = "x".repeat(MAX_ERROR_BODY_CHARS + 20);
        let CloudWhisperError::Other { message, .. } =
            classify_cloud_whisper_error(400, &long_body)
        else {
            panic!("400 should classify as Other");
        };
        assert_eq!(message.len(), MAX_ERROR_BODY_CHARS + 3);
        assert!(message.ends_with("..."));
    }

    #[test]
    fn classify_499_returns_other() {
        assert_eq!(
            classify_cloud_whisper_error(499, "boundary-before-5xx"),
            CloudWhisperError::Other {
                status: 499,
                message: "boundary-before-5xx".to_string(),
            }
        );
    }

    #[test]
    fn classify_600_returns_other() {
        assert_eq!(
            classify_cloud_whisper_error(600, "boundary-after-5xx"),
            CloudWhisperError::Other {
                status: 600,
                message: "boundary-after-5xx".to_string(),
            }
        );
    }

    #[test]
    fn classify_200_returns_other_safely() {
        assert_eq!(
            classify_cloud_whisper_error(200, "unexpected success in error path"),
            CloudWhisperError::Other {
                status: 200,
                message: "unexpected success in error path".to_string(),
            }
        );
    }

    #[test]
    fn sanitize_error_body_falls_back_to_empty_marker_for_whitespace_only_inputs() {
        assert_eq!(super::sanitize_error_body(""), "HTTP error body was empty");
        assert_eq!(
            super::sanitize_error_body("   "),
            "HTTP error body was empty"
        );
        assert_eq!(
            super::sanitize_error_body("\t\n  "),
            "HTTP error body was empty"
        );
    }

    #[test]
    fn sanitize_error_body_truncates_multibyte_text_by_char_count_not_byte_count() {
        let body = "あ".repeat(super::MAX_ERROR_BODY_CHARS + 5);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), super::MAX_ERROR_BODY_CHARS + 3);
        assert!(result.ends_with("..."));
        assert!(result.starts_with("あ"));
    }

    #[test]
    fn sanitize_error_body_does_not_truncate_at_199_chars() {
        let body = "x".repeat(super::MAX_ERROR_BODY_CHARS - 1);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), 199);
        assert_eq!(result, "x".repeat(199));
        assert!(!result.ends_with("..."));
    }

    #[test]
    fn sanitize_error_body_does_not_truncate_at_exactly_200_chars() {
        let body = "x".repeat(super::MAX_ERROR_BODY_CHARS);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), 200);
        assert_eq!(result, "x".repeat(200));
        assert!(!result.ends_with("..."));
    }

    #[test]
    fn sanitize_error_body_truncates_at_201_chars() {
        let body = "x".repeat(super::MAX_ERROR_BODY_CHARS + 1);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), super::MAX_ERROR_BODY_CHARS + 3);
        assert!(result.ends_with("..."));
        assert!(result.starts_with(&"x".repeat(super::MAX_ERROR_BODY_CHARS)));
    }

    #[test]
    fn sanitize_error_body_normalizes_whitespace_before_counting_chars() {
        // 100 "x"s joined by 4 spaces: raw = 100 + 99*4 = 496 chars (> MAX=200),
        // but split_whitespace().join(" ") yields 100 + 99 = 199 chars (< MAX).
        let body = (0..100).map(|_| "x").collect::<Vec<_>>().join("    ");
        assert_eq!(body.chars().count(), 496);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), 199);
        assert!(!result.ends_with("..."));
        assert_eq!(result, (0..100).map(|_| "x").collect::<Vec<_>>().join(" "));
    }

    #[test]
    fn sanitize_error_body_truncates_multibyte_at_exactly_201_chars() {
        let body = "あ".repeat(super::MAX_ERROR_BODY_CHARS + 1);
        let result = super::sanitize_error_body(&body);
        assert_eq!(result.chars().count(), super::MAX_ERROR_BODY_CHARS + 3);
        assert!(result.ends_with("..."));
        assert!(result.starts_with("あ"));
        assert!(result
            .chars()
            .take(super::MAX_ERROR_BODY_CHARS)
            .all(|c| c == 'あ'));
    }

    #[test]
    fn classify_returns_other_for_status_adjacent_to_401_and_429() {
        // 401 隣接: 402 (400 は既存 line 70 でテスト済なのでここでは含めない)
        assert_eq!(
            classify_cloud_whisper_error(402, "payment required"),
            CloudWhisperError::Other {
                status: 402,
                message: "payment required".to_string(),
            },
            "402 は 401 の隣接 +1 でも Other に落ち、InvalidApiKey にならないこと"
        );

        // 429 隣接: 428 と 430
        assert_eq!(
            classify_cloud_whisper_error(428, "precondition required"),
            CloudWhisperError::Other {
                status: 428,
                message: "precondition required".to_string(),
            },
            "428 は 429 の隣接 -1 でも Other に落ち、RateLimited にならないこと"
        );
        assert_eq!(
            classify_cloud_whisper_error(430, "rfc-unassigned"),
            CloudWhisperError::Other {
                status: 430,
                message: "rfc-unassigned".to_string(),
            },
            "430 は 429 の隣接 +1 でも Other に落ち、RateLimited にならないこと"
        );
    }

    #[test]
    fn classify_returns_server_error_for_5xx_range_interior() {
        // 500..=599 range の中間 4 点 (上下限 500/599 は既存 line 60-68 で網羅済)
        for status in [501u16, 520, 550, 598] {
            assert_eq!(
                classify_cloud_whisper_error(status, "any body"),
                CloudWhisperError::ServerError,
                "5xx range 内の {status} は ServerError になるはず (range の一様性)"
            );
        }
    }

    #[test]
    fn classify_returns_other_for_u16_endpoints_without_overflow() {
        assert_eq!(
            classify_cloud_whisper_error(0, "zero status"),
            CloudWhisperError::Other {
                status: 0,
                message: "zero status".to_string(),
            },
            "u16::MIN (0) は Other に落ち、crash しない契約"
        );
        assert_eq!(
            classify_cloud_whisper_error(1, "one"),
            CloudWhisperError::Other {
                status: 1,
                message: "one".to_string(),
            },
            "u16=1 は Other に落ちる (1xx 系の下端より下)"
        );
        assert_eq!(
            classify_cloud_whisper_error(u16::MAX, "max status"),
            CloudWhisperError::Other {
                status: u16::MAX,
                message: "max status".to_string(),
            },
            "u16::MAX (65535) は Other に落ち、overflow なしで status field に正しく入る契約"
        );
    }

    #[test]
    fn classify_does_not_leak_body_into_invalid_api_key_or_rate_limited_or_server_error_variants() {
        let long_body = "x".repeat(1000);
        let multibyte_body = "あ".repeat(500);
        let multiline_body = "line1\nline2\r\nline3\t  trailing  ";

        for body in [
            long_body.as_str(),
            multibyte_body.as_str(),
            multiline_body,
            "",
        ] {
            let body_preview: String = body.chars().take(20).collect();
            assert_eq!(
                classify_cloud_whisper_error(401, body),
                CloudWhisperError::InvalidApiKey,
                "401 は body (`{body_preview}`...) を完全無視して InvalidApiKey に落ちる契約"
            );
            assert_eq!(
                classify_cloud_whisper_error(429, body),
                CloudWhisperError::RateLimited,
                "429 は body を完全無視して RateLimited に落ちる契約"
            );
            assert_eq!(
                classify_cloud_whisper_error(500, body),
                CloudWhisperError::ServerError,
                "500 は body を完全無視して ServerError に落ちる契約"
            );
            assert_eq!(
                classify_cloud_whisper_error(599, body),
                CloudWhisperError::ServerError,
                "599 は body を完全無視して ServerError に落ちる契約"
            );
        }
    }

    #[test]
    fn classify_other_is_pure_function_with_status_in_field_only_not_in_message() {
        // (1) idempotency: 同じ (status, body) を 2 回呼ぶと結果が同一
        let first = classify_cloud_whisper_error(404, "not found");
        let second = classify_cloud_whisper_error(404, "not found");
        assert_eq!(
            first, second,
            "同じ入力で 2 回呼んでも結果同一 (純粋関数性)"
        );

        // (2) status の数値が message に漏れない (404 という文字列が message に含まれない)
        if let CloudWhisperError::Other { status, message } = first {
            assert_eq!(status, 404, "status field に 404 が入る");
            assert_eq!(
                message, "not found",
                "message field には body のみが入り、status の数値文字列は混入しない契約"
            );
            assert!(
                !message.contains("404"),
                "message に status の数値 '404' が漏れていない契約: message=`{message}`"
            );
        } else {
            panic!("404 should classify as Other");
        }

        // (3) 異なる status・同じ body でも message が同一 (status 非依存)
        let a = classify_cloud_whisper_error(403, "shared body");
        let b = classify_cloud_whisper_error(409, "shared body");
        if let (
            CloudWhisperError::Other { message: msg_a, .. },
            CloudWhisperError::Other { message: msg_b, .. },
        ) = (a, b)
        {
            assert_eq!(
                msg_a, msg_b,
                "同じ body なら message は status 非依存で同一になる契約"
            );
            assert_eq!(msg_a, "shared body");
        } else {
            panic!("403 and 409 should both classify as Other");
        }
    }

    #[test]
    fn classify_returns_other_for_3xx_redirect_status_range_without_falling_through_to_5xx() {
        for (status, body) in [
            (301, "moved permanently"),
            (302, "found"),
            (304, "not modified"),
        ] {
            assert_eq!(
                classify_cloud_whisper_error(status, body),
                CloudWhisperError::Other {
                    status,
                    message: body.to_string(),
                },
                "{status} (3xx redirect) は 500..=599 範囲外で Other に落ちる契約 (ServerError ではない)"
            );
        }
    }

    #[test]
    fn classify_other_preserves_nul_byte_in_body_message_because_nul_is_not_whitespace() {
        let body = "abc\0def";
        let CloudWhisperError::Other { message, .. } = classify_cloud_whisper_error(400, body)
        else {
            panic!("400 should classify as Other");
        };
        assert_eq!(
            message, "abc\0def",
            "NUL byte は char::is_whitespace で false なので split_whitespace で除去されず passthrough する契約"
        );
        assert!(
            message.contains('\0'),
            "message に NUL byte が含まれる (sanitize で消されない)"
        );
    }

    #[test]
    fn classify_other_with_same_status_yields_distinct_messages_for_distinct_bodies_pure_function_inverse_axis(
    ) {
        let a = classify_cloud_whisper_error(404, "body alpha");
        let b = classify_cloud_whisper_error(404, "body beta");
        if let (
            CloudWhisperError::Other {
                status: status_a,
                message: msg_a,
            },
            CloudWhisperError::Other {
                status: status_b,
                message: msg_b,
            },
        ) = (a, b)
        {
            assert_eq!(status_a, 404);
            assert_eq!(status_b, 404);
            assert_eq!(msg_a, "body alpha");
            assert_eq!(msg_b, "body beta");
            assert_ne!(
                msg_a, msg_b,
                "同 status (404) × 異 body で message は異なる契約 (pure function: body は message に passthrough、status の値だけで上書きしない)"
            );
        } else {
            panic!("both 404 calls should classify as Other");
        }
    }

    #[test]
    fn cloud_whisper_error_debug_format_contains_variant_names_and_other_field_values() {
        let invalid = CloudWhisperError::InvalidApiKey;
        let rate = CloudWhisperError::RateLimited;
        let server = CloudWhisperError::ServerError;
        let other = CloudWhisperError::Other {
            status: 418,
            message: String::from("teapot"),
        };

        let invalid_dbg = format!("{invalid:?}");
        let rate_dbg = format!("{rate:?}");
        let server_dbg = format!("{server:?}");
        let other_dbg = format!("{other:?}");

        assert!(
            invalid_dbg.contains("InvalidApiKey"),
            "InvalidApiKey variant: {invalid_dbg}"
        );
        assert!(
            rate_dbg.contains("RateLimited"),
            "RateLimited variant: {rate_dbg}"
        );
        assert!(
            server_dbg.contains("ServerError"),
            "ServerError variant: {server_dbg}"
        );
        assert!(other_dbg.contains("Other"), "Other variant: {other_dbg}");
        assert!(
            other_dbg.contains("status"),
            "Other status field: {other_dbg}"
        );
        assert!(other_dbg.contains("418"), "Other status value: {other_dbg}");
        assert!(
            other_dbg.contains("message"),
            "Other message field: {other_dbg}"
        );
        assert!(
            other_dbg.contains("teapot"),
            "Other message value: {other_dbg}"
        );
    }

    #[test]
    fn cloud_whisper_error_other_clone_is_independent_and_equal_to_original() {
        let original = CloudWhisperError::Other {
            status: 503,
            message: String::from("upstream"),
        };
        let cloned = original.clone();
        assert_eq!(original, cloned, "Clone は原本と等しい");

        let original_dbg = format!("{original:?}");
        let cloned_dbg = format!("{cloned:?}");
        assert_eq!(original_dbg, cloned_dbg, "Clone の Debug 表示も一致");
    }

    #[test]
    fn cloud_whisper_error_partial_eq_distinguishes_other_fields_and_variant_kinds() {
        let base = CloudWhisperError::Other {
            status: 500,
            message: String::from("a"),
        };
        let diff_status = CloudWhisperError::Other {
            status: 502,
            message: String::from("a"),
        };
        let diff_message = CloudWhisperError::Other {
            status: 500,
            message: String::from("b"),
        };

        assert_ne!(base, diff_status, "status 違い: 不等");
        assert_ne!(base, diff_message, "message 違い: 不等");
        assert_ne!(
            CloudWhisperError::InvalidApiKey,
            CloudWhisperError::RateLimited,
            "variant 間不等"
        );
        assert_ne!(
            CloudWhisperError::ServerError,
            base,
            "ServerError と Other は不等"
        );
    }
}
