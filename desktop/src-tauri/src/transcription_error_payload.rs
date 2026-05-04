use crate::transcription_types::{TranscriptionErrorPayload, TranscriptionSource};

pub(crate) fn build_transcription_error_payload(
    error: String,
    source: Option<TranscriptionSource>,
) -> TranscriptionErrorPayload {
    TranscriptionErrorPayload { error, source }
}

pub(crate) fn build_worker_panic_error_payload(
    source: Option<TranscriptionSource>,
) -> TranscriptionErrorPayload {
    build_transcription_error_payload("文字起こしワーカーが異常終了しました".to_string(), source)
}

#[cfg(test)]
pub(crate) fn transcription_error_payload_to_value(
    payload: &TranscriptionErrorPayload,
) -> serde_json::Value {
    serde_json::to_value(payload).expect("transcription error payload should serialize to JSON")
}

pub(crate) fn is_realtime_stream_already_stopped_error(error: &str) -> bool {
    error.contains("Realtime ストリームが既に停止しています")
}

pub(crate) fn should_emit_realtime_stream_error(error: &str) -> bool {
    !is_realtime_stream_already_stopped_error(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription_types::{TranscriptionErrorPayload, TranscriptionSource};

    #[test]
    fn test_worker_panic_payload_does_not_expose_panic_details() {
        let payload = build_worker_panic_error_payload(Some(TranscriptionSource::Microphone));
        let payload = transcription_error_payload_to_value(&payload);
        assert_eq!(
            payload.get("error").and_then(|value| value.as_str()),
            Some("文字起こしワーカーが異常終了しました")
        );
        assert_eq!(
            payload.get("source").and_then(|value| value.as_str()),
            Some("microphone")
        );
        let serialized = payload.to_string();
        assert!(!serialized.contains("panic"));
        assert!(!serialized.contains("payload"));
    }

    #[test]
    fn test_transcription_error_payload_serialization_with_source() {
        let payload = build_transcription_error_payload(
            "入力音声の処理に失敗しました".to_string(),
            Some(TranscriptionSource::SystemAudio),
        );

        assert_eq!(
            transcription_error_payload_to_value(&payload),
            serde_json::json!({
                "error": "入力音声の処理に失敗しました",
                "source": "system_audio",
            })
        );
    }

    #[test]
    fn test_transcription_error_payload_serialization_omits_missing_source() {
        let payload = build_transcription_error_payload("初期化に失敗しました".to_string(), None);

        assert_eq!(
            transcription_error_payload_to_value(&payload),
            serde_json::json!({
                "error": "初期化に失敗しました",
            })
        );
    }

    #[test]
    fn test_stopped_realtime_stream_errors_are_not_emitted_to_ui() {
        assert!(!should_emit_realtime_stream_error(
            "OpenAI Realtime ストリームが既に停止しています"
        ));
        assert!(!should_emit_realtime_stream_error(
            "ElevenLabs Realtime ストリームが既に停止しています"
        ));
        assert!(!should_emit_realtime_stream_error(
            "Custom Realtime ストリームが既に停止しています"
        ));
        assert!(should_emit_realtime_stream_error(
            "リサンプリングエラー: invalid input"
        ));
    }

    #[test]
    fn build_worker_panic_error_payload_omits_source_when_none() {
        let payload = build_worker_panic_error_payload(None);
        let v = transcription_error_payload_to_value(&payload);
        assert!(v.get("source").is_none());
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("文字起こしワーカーが異常終了しました")
        );
    }

    #[test]
    fn build_transcription_error_payload_preserves_empty_error_string() {
        let payload =
            build_transcription_error_payload(String::new(), Some(TranscriptionSource::Microphone));
        let v = transcription_error_payload_to_value(&payload);
        assert_eq!(v.get("error").and_then(|x| x.as_str()), Some(""));
    }

    #[test]
    fn is_realtime_stream_already_stopped_error_is_case_sensitive_for_ascii_realtime_prefix() {
        // 既存 test は "Realtime" 大文字始まりのみ。"realtime" 小文字始まりは
        // substring 一致 ("Realtime ストリームが既に停止しています") を満たさず
        // false を返す現契約を CI 固定。
        // 大小区別を to_lowercase 等で潰す誤改修を検知する装置。
        assert!(
            !is_realtime_stream_already_stopped_error("realtime ストリームが既に停止しています"),
            "ASCII 部分は大小区別される現契約 (substring 一致は case-sensitive)"
        );
        assert!(
            should_emit_realtime_stream_error("realtime ストリームが既に停止しています"),
            "false 判定なら UI emit される (graceful stop 扱いされない)"
        );
    }

    #[test]
    fn is_realtime_stream_already_stopped_error_matches_substring_at_any_position() {
        // 既存 test は prefix 付き ("OpenAI Realtime ..." 等) と prefix なし
        // ("Realtime ストリーム..." property test 内) のみ。
        // substring が文字列の中間に出現するケース (prefix + suffix 両方付き) は未保護。
        // contains() 仕様上 true を返す現契約を CI 固定 (誤って startsWith 化する改修を検知)。
        assert!(
            is_realtime_stream_already_stopped_error(
                "WARNING: OpenAI Realtime ストリームが既に停止しています (graceful)"
            ),
            "substring が中間 (prefix + suffix 両側) に出現しても true (contains 任意位置一致)"
        );
        assert!(
            !should_emit_realtime_stream_error(
                "WARNING: OpenAI Realtime ストリームが既に停止しています (graceful)"
            ),
            "true 判定なら UI emit を抑止 (graceful stop の noise を捨てる)"
        );
    }

    #[test]
    fn is_realtime_stream_already_stopped_error_matches_across_newlines() {
        // 既存 test は単行メッセージのみ。多行メッセージで substring が
        // 行をまたいで出現しないケースでも、contains() は \n を区切らないため
        // true を返す現契約を CI 固定。
        // 例: "ERROR\nOpenAI Realtime ストリームが既に停止しています\nstack trace..."
        let multiline =
            "ERROR\nOpenAI Realtime ストリームが既に停止しています\nstack trace at line 42";
        assert!(
            is_realtime_stream_already_stopped_error(multiline),
            "改行を含む多行メッセージでも substring が単一行内にあれば true"
        );
        assert!(
            !should_emit_realtime_stream_error(multiline),
            "true なら UI emit 抑止 (多行 stack trace 含む graceful stop も noise として捨てる)"
        );
    }

    #[test]
    fn build_transcription_error_payload_serialization_with_microphone_source() {
        // 既存 test_transcription_error_payload_serialization_with_source は SystemAudio のみカバー。
        // Microphone enum バリアントの serialization (snake_case → "microphone") を CI 固定。
        // 2x2 マトリクス (関数 × TranscriptionSource enum) の未保護セルを充填。
        let payload = build_transcription_error_payload(
            "マイク入力の処理に失敗しました".to_string(),
            Some(TranscriptionSource::Microphone),
        );
        assert_eq!(
            transcription_error_payload_to_value(&payload),
            serde_json::json!({
                "error": "マイク入力の処理に失敗しました",
                "source": "microphone",
            })
        );
    }

    #[test]
    fn build_worker_panic_error_payload_serialization_with_system_audio_source() {
        // 既存 test_worker_panic_payload_does_not_expose_panic_details は Microphone のみ、
        // build_worker_panic_error_payload_omits_source_when_none は None のみ。
        // SystemAudio enum バリアントは未保護 = 2x2 マトリクス (関数 × source) の最後の未充填セル。
        // panic details 漏洩防止と source 値の正確性を同時に CI 固定。
        let payload = build_worker_panic_error_payload(Some(TranscriptionSource::SystemAudio));
        let v = transcription_error_payload_to_value(&payload);
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("文字起こしワーカーが異常終了しました"),
            "panic 文言は固定 (panic details 漏洩防止)"
        );
        assert_eq!(
            v.get("source").and_then(|x| x.as_str()),
            Some("system_audio"),
            "SystemAudio enum バリアントは snake_case で system_audio に serialize される"
        );
        let serialized = v.to_string();
        assert!(
            !serialized.contains("panic"),
            "panic という文字列を含まない"
        );
        assert!(
            !serialized.contains("payload"),
            "payload という文字列を含まない"
        );
    }

    #[test]
    fn build_transcription_error_payload_escapes_newlines_in_error_string() {
        // 改行を含む error 文字列が serde_json 標準で "\\n" にエスケープされる現契約を CI 固定。
        // Tauri event payload (Rust → JS string) として渡る際、改行が JSON valid な escape sequence
        // であることを保証 = フロントエンド側で JSON.parse 後に \n として復元される互換性を保護。
        // 例: "ERROR\nstack trace\n  at line 42" のような複数行 error も payload として安全に運べる。
        let payload = build_transcription_error_payload(
            "ERROR\nstack trace\n  at line 42".to_string(),
            Some(TranscriptionSource::SystemAudio),
        );
        let v = transcription_error_payload_to_value(&payload);
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("ERROR\nstack trace\n  at line 42"),
            "as_str() で取り出すと \\n は復元される (JSON 内部表現は \\\\n だが Value 経由で透過)"
        );
        let serialized = v.to_string();
        assert!(
            serialized.contains(r"ERROR\nstack trace\n  at line 42"),
            "to_string() の生 JSON 文字列では改行が \\\\n にエスケープされる: {serialized}"
        );
    }

    #[test]
    fn transcription_error_payload_debug_output_contains_struct_name_field_names_and_some_variant_with_enum_name(
    ) {
        // #[derive(Debug)] 自動派生による「struct with Option<enum> field の Debug 出力」契約の
        // executable specification 化 = 将来 source field の Debug 表現変更や TranscriptionSource
        // variant rename の波及を遮断する装置。
        let payload = TranscriptionErrorPayload {
            error: "msg".to_string(),
            source: Some(TranscriptionSource::SystemAudio),
        };
        let output = format!("{:?}", payload);
        assert!(
            output.contains("TranscriptionErrorPayload"),
            "型名 TranscriptionErrorPayload が含まれる: {output}"
        );
        assert!(
            output.contains("error"),
            "field 名 error が含まれる: {output}"
        );
        assert!(
            output.contains("source"),
            "field 名 source が含まれる: {output}"
        );
        assert!(
            output.contains("msg"),
            "error field の値 msg が含まれる: {output}"
        );
        assert!(
            output.contains("Some"),
            "Option::Some の Debug 表現 Some が含まれる: {output}"
        );
        assert!(
            output.contains("SystemAudio"),
            "enum variant 名 SystemAudio が含まれる: {output}"
        );
        let none_payload = TranscriptionErrorPayload {
            error: "err".to_string(),
            source: None,
        };
        let none_output = format!("{:?}", none_payload);
        assert!(
            none_output.contains("None"),
            "source: None の Debug 出力に None が含まれる: {none_output}"
        );
    }

    #[test]
    fn transcription_error_payload_debug_output_equals_after_clone_for_some_and_none_variants() {
        // #[derive(Debug, Clone)] の組み合わせで clone 後の Debug 出力が 100% 同一である契約を CI 固定。
        // 将来 Clone を手動実装して Option field を加工する誤改修を遮断する装置。
        let some_payload = TranscriptionErrorPayload {
            error: "original".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        assert_eq!(
            format!("{:?}", some_payload),
            format!("{:?}", some_payload.clone()),
            "Some 持ち payload の Debug 出力は clone 後と完全一致する"
        );
        let none_payload = TranscriptionErrorPayload {
            error: "no_source".to_string(),
            source: None,
        };
        assert_eq!(
            format!("{:?}", none_payload),
            format!("{:?}", none_payload.clone()),
            "None 持ち payload の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn transcription_error_payload_partial_eq_holds_reflexive_and_differs_for_distinct_error_or_source(
    ) {
        // #[derive(PartialEq, Eq)] による「全 field が等値判定対象」契約を CI 固定。
        // 将来 PartialEq を手動実装して source を等値判定から除外する誤改修を遮断する装置。
        let a = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        let b = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        assert_eq!(a, b, "同 error + 同 source は等値 (reflexive)");
        let diff_error = TranscriptionErrorPayload {
            error: "different".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        assert_ne!(a, diff_error, "異 error / 同 source は不等");
        let diff_source = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: Some(TranscriptionSource::SystemAudio),
        };
        assert_ne!(
            a, diff_source,
            "同 error / 異 source (Microphone vs SystemAudio) は不等"
        );
        let none_source = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: None,
        };
        assert_ne!(a, none_source, "同 error / Some vs None の source 差は不等");
    }
}
