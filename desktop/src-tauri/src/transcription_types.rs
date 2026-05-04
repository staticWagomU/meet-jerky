use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionSource {
    Microphone,
    SystemAudio,
}

/// 文字起こし結果の1セグメント
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TranscriptionSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>, // "自分" (mic) or "相手側" (system audio)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// 文字起こし worker から UI へ通知するエラー payload。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TranscriptionErrorPayload {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TranscriptionSource>,
}

/// 利用可能なモデルの情報
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub display_name: String,
    pub size_mb: u64,
    pub url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transcription_segment_serialization() {
        // speaker: None の場合、JSONに speaker フィールドが含まれないことを確認
        let segment = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            source: None,
            speaker: None,
            is_error: None,
        };
        let json = serde_json::to_string(&segment).unwrap();
        assert!(json.contains("startMs"));
        assert!(json.contains("endMs"));
        assert!(!json.contains("start_ms"));
        assert!(
            !json.contains("speaker"),
            "speaker: None should be skipped in JSON"
        );
        assert!(
            !json.contains("isError"),
            "is_error: None should be skipped in JSON"
        );

        // speaker: Some("自分") の場合、JSONに speaker フィールドが含まれることを確認
        let segment_with_speaker = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            source: Some(TranscriptionSource::Microphone),
            speaker: Some("自分".to_string()),
            is_error: Some(true),
        };
        let json_with_speaker = serde_json::to_string(&segment_with_speaker).unwrap();
        assert!(
            json_with_speaker.contains("\"speaker\":\"自分\""),
            "speaker: Some(\"自分\") should appear in JSON"
        );
        assert!(
            json_with_speaker.contains("\"source\":\"microphone\""),
            "source should serialize as snake_case"
        );
        assert!(
            json_with_speaker.contains("\"isError\":true"),
            "is_error: Some(true) should serialize as isError"
        );
    }

    #[test]
    fn transcription_segment_debug_output_contains_struct_name_all_six_field_names_and_values() {
        // #[derive(Debug)] 派生で struct 名・全 6 snake_case field 名・値・Some/None・enum variant 名が
        // Debug 出力に含まれる契約を CI 固定。将来 Debug を手動実装して field を隠蔽する誤改修を遮断する。
        let segment = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 100,
            end_ms: 2000,
            source: Some(TranscriptionSource::SystemAudio),
            speaker: Some("自分".to_string()),
            is_error: Some(true),
        };
        let dbg = format!("{:?}", segment);
        assert!(
            dbg.contains("TranscriptionSegment"),
            "型名 TranscriptionSegment が含まれる: {dbg}"
        );
        assert!(dbg.contains("text"), "field 名 text が含まれる: {dbg}");
        assert!(
            dbg.contains("start_ms"),
            "field 名 start_ms が含まれる: {dbg}"
        );
        assert!(dbg.contains("end_ms"), "field 名 end_ms が含まれる: {dbg}");
        assert!(dbg.contains("source"), "field 名 source が含まれる: {dbg}");
        assert!(
            dbg.contains("speaker"),
            "field 名 speaker が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("is_error"),
            "field 名 is_error が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("hello"),
            "text field の値 hello が含まれる: {dbg}"
        );
        assert!(dbg.contains("100"), "start_ms の値 100 が含まれる: {dbg}");
        assert!(dbg.contains("2000"), "end_ms の値 2000 が含まれる: {dbg}");
        assert!(dbg.contains("自分"), "speaker の値 自分 が含まれる: {dbg}");
        assert!(dbg.contains("true"), "is_error の値 true が含まれる: {dbg}");
        assert!(
            dbg.contains("Some"),
            "Option::Some の Debug 表現 Some が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("SystemAudio"),
            "enum variant 名 SystemAudio が含まれる: {dbg}"
        );
    }

    #[test]
    fn transcription_segment_debug_output_equals_after_clone_for_some_and_none_variants() {
        // #[derive(Debug, Clone)] の組み合わせで clone 後の Debug 出力が 100% 同一である契約を CI 固定。
        // 将来 Clone を手動実装して Option field を加工する誤改修を遮断する。
        let full = TranscriptionSegment {
            text: "full".to_string(),
            start_ms: 0,
            end_ms: 500,
            source: Some(TranscriptionSource::Microphone),
            speaker: Some("自分".to_string()),
            is_error: Some(false),
        };
        assert_eq!(
            format!("{:?}", full),
            format!("{:?}", full.clone()),
            "全 Some 埋め segment の Debug 出力は clone 後と完全一致する"
        );
        let bare = TranscriptionSegment {
            text: "bare".to_string(),
            start_ms: -1,
            end_ms: 0,
            source: None,
            speaker: None,
            is_error: None,
        };
        assert_eq!(
            format!("{:?}", bare),
            format!("{:?}", bare.clone()),
            "全 Option None segment の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn transcription_segment_serde_serializes_with_camel_case_field_names_and_skips_none_options() {
        // #[serde(rename_all = "camelCase")] + #[serde(skip_serializing_if = "Option::is_none")] の
        // 組み合わせ契約を CI 固定。将来 serde 属性が外されたり個別 rename された誤改修を遮断する。
        let bare = TranscriptionSegment {
            text: "bare".to_string(),
            start_ms: -5,
            end_ms: 0,
            source: None,
            speaker: None,
            is_error: None,
        };
        let json = serde_json::to_string(&bare).unwrap();
        assert!(
            json.contains("\"text\""),
            "必須 field text が JSON に含まれる: {json}"
        );
        assert!(
            json.contains("\"startMs\""),
            "camelCase field startMs が JSON に含まれる: {json}"
        );
        assert!(
            json.contains("\"endMs\""),
            "camelCase field endMs が JSON に含まれる: {json}"
        );
        assert!(
            !json.contains("\"start_ms\""),
            "snake_case field start_ms は JSON に出ない: {json}"
        );
        assert!(
            !json.contains("\"end_ms\""),
            "snake_case field end_ms は JSON に出ない: {json}"
        );
        assert!(
            !json.contains("\"is_error\""),
            "snake_case field is_error は JSON に出ない: {json}"
        );
        assert!(
            !json.contains("\"isError\""),
            "None の isError は JSON に含まれない: {json}"
        );
        assert!(
            !json.contains("\"speaker\""),
            "None の speaker は JSON に含まれない: {json}"
        );
        assert!(
            !json.contains("\"source\""),
            "None の source は JSON に含まれない: {json}"
        );
        let full = TranscriptionSegment {
            text: "full".to_string(),
            start_ms: 10,
            end_ms: 20,
            source: Some(TranscriptionSource::SystemAudio),
            speaker: Some("相手側".to_string()),
            is_error: Some(true),
        };
        let json = serde_json::to_string(&full).unwrap();
        assert!(
            json.contains("\"isError\""),
            "Some の isError は camelCase で JSON に含まれる: {json}"
        );
        assert!(
            !json.contains("\"is_error\""),
            "snake_case の is_error は JSON に出ない: {json}"
        );
        assert!(
            json.contains("\"system_audio\"") || json.contains("system_audio"),
            "TranscriptionSource::SystemAudio の serde 値は snake_case (system_audio): {json}"
        );
    }

    #[test]
    fn transcription_source_debug_output_contains_each_variant_name_per_variant() {
        let mic = TranscriptionSource::Microphone;
        let sys = TranscriptionSource::SystemAudio;
        let dbg_mic = format!("{:?}", mic);
        let dbg_sys = format!("{:?}", sys);
        assert!(
            dbg_mic.contains("Microphone"),
            "Microphone variant の Debug 出力に variant 名 Microphone が含まれる: {dbg_mic}"
        );
        assert!(
            dbg_sys.contains("SystemAudio"),
            "SystemAudio variant の Debug 出力に variant 名 SystemAudio が含まれる: {dbg_sys}"
        );
        assert_ne!(
            dbg_mic, dbg_sys,
            "Microphone と SystemAudio の Debug 出力は異なる"
        );
    }

    #[test]
    fn transcription_source_copy_trait_keeps_original_usable_after_assignment() {
        let original = TranscriptionSource::Microphone;
        let copied = original;
        assert_eq!(
            original, copied,
            "Copy 派生で copied が original の値と等しい"
        );
        assert_eq!(
            original,
            TranscriptionSource::Microphone,
            "Copy 後も original は Microphone のまま使える"
        );
        let s_original = TranscriptionSource::SystemAudio;
        let s_copied = s_original;
        assert_eq!(
            s_original, s_copied,
            "Copy 派生で SystemAudio も copy される"
        );
        assert_eq!(
            s_original,
            TranscriptionSource::SystemAudio,
            "Copy 後も SystemAudio の original は使える"
        );
    }

    #[test]
    fn transcription_source_serde_serializes_each_variant_with_snake_case_value() {
        let cases: &[(TranscriptionSource, &str)] = &[
            (TranscriptionSource::Microphone, "microphone"),
            (TranscriptionSource::SystemAudio, "system_audio"),
        ];
        for (variant, expected) in cases {
            let value = serde_json::to_value(variant).unwrap();
            assert_eq!(
                value,
                serde_json::Value::String((*expected).to_string()),
                "{:?} は serde で {} に serialize される",
                variant,
                expected
            );
            let s = serde_json::to_string(variant).unwrap();
            assert_eq!(
                s,
                format!("\"{}\"", expected),
                "{:?} は serde で \"{}\" に文字列化される",
                variant,
                expected
            );
        }
    }

    #[test]
    fn model_info_debug_output_contains_struct_name_and_all_four_field_names() {
        let info = ModelInfo {
            name: "tiny-q5_1".to_string(),
            display_name: "Tiny (Q5_1)".to_string(),
            size_mb: 31,
            url: "https://example.com/tiny.bin".to_string(),
        };
        let s = format!("{:?}", info);

        // 型名
        assert!(
            s.contains("ModelInfo"),
            "Debug should contain type name 'ModelInfo': {}",
            s
        );
        // snake_case field 名 (4 個)
        assert!(
            s.contains("name"),
            "Debug should contain field 'name': {}",
            s
        );
        assert!(
            s.contains("display_name"),
            "Debug should contain field 'display_name': {}",
            s
        );
        assert!(
            s.contains("size_mb"),
            "Debug should contain field 'size_mb': {}",
            s
        );
        assert!(s.contains("url"), "Debug should contain field 'url': {}", s);
        // 値
        assert!(
            s.contains("\"tiny-q5_1\""),
            "Debug should contain name value: {}",
            s
        );
        assert!(
            s.contains("\"Tiny (Q5_1)\""),
            "Debug should contain display_name value: {}",
            s
        );
        assert!(
            s.contains("31"),
            "Debug should contain size_mb value: {}",
            s
        );
        assert!(
            s.contains("\"https://example.com/tiny.bin\""),
            "Debug should contain url value: {}",
            s
        );
    }

    #[test]
    fn model_info_clone_produces_independent_copy_for_string_fields_and_size_mb() {
        let original = ModelInfo {
            name: "tiny".to_string(),
            display_name: "Tiny".to_string(),
            size_mb: 31,
            url: "https://example.com/tiny.bin".to_string(),
        };
        let mut cloned = original.clone();

        // cloned を変更
        cloned.name.push_str("-q5_1");
        cloned.display_name = "Tiny (Q5_1)".to_string();
        cloned.size_mb = 99;
        cloned.url = "https://example.com/other.bin".to_string();

        // original が変化していない (deep clone 契約)
        assert_eq!(
            original.name, "tiny",
            "original.name should be unchanged after cloned mutation"
        );
        assert_eq!(
            original.display_name, "Tiny",
            "original.display_name should be unchanged"
        );
        assert_eq!(original.size_mb, 31, "original.size_mb should be unchanged");
        assert_eq!(
            original.url, "https://example.com/tiny.bin",
            "original.url should be unchanged"
        );

        // cloned が確かに変更されている (mutation 自体が起きた裏付け)
        assert_eq!(cloned.name, "tiny-q5_1");
        assert_eq!(cloned.display_name, "Tiny (Q5_1)");
        assert_eq!(cloned.size_mb, 99);
        assert_eq!(cloned.url, "https://example.com/other.bin");
    }

    #[test]
    fn model_info_serialize_uses_camel_case_for_all_four_fields() {
        let info = ModelInfo {
            name: "tiny-q5_1".to_string(),
            display_name: "Tiny (Q5_1)".to_string(),
            size_mb: 31,
            url: "https://example.com/tiny.bin".to_string(),
        };
        let s = serde_json::to_string(&info).expect("ModelInfo should serialize");

        // camelCase 4 key 存在
        assert!(s.contains("\"name\":"), "should contain 'name' key: {}", s);
        assert!(
            s.contains("\"displayName\":"),
            "should contain 'displayName' key: {}",
            s
        );
        assert!(
            s.contains("\"sizeMb\":"),
            "should contain 'sizeMb' key: {}",
            s
        );
        assert!(s.contains("\"url\":"), "should contain 'url' key: {}", s);
        // snake_case 不在 (rename_all 適用の証明)
        assert!(
            !s.contains("\"display_name\":"),
            "should NOT contain snake_case 'display_name': {}",
            s
        );
        assert!(
            !s.contains("\"size_mb\":"),
            "should NOT contain snake_case 'size_mb': {}",
            s
        );
        // 値正しさ
        assert!(
            s.contains("\"tiny-q5_1\""),
            "should contain name value: {}",
            s
        );
        assert!(
            s.contains("\"Tiny (Q5_1)\""),
            "should contain display_name value: {}",
            s
        );
        assert!(
            s.contains(":31"),
            "should contain size_mb numeric value 31: {}",
            s
        );
        assert!(
            s.contains("\"https://example.com/tiny.bin\""),
            "should contain url value: {}",
            s
        );
    }
}
