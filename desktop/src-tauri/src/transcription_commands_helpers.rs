//! 文字起こし開始時の純粋関数 helpers (validate / parse / 関連定数 / RequestedTranscriptionSources struct)。
//!
//! Loop 101 で transcription_commands.rs から分離。state 依存ゼロの純粋関数のみ。

use crate::settings::TranscriptionEngineType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RequestedTranscriptionSources {
    pub(crate) use_mic: bool,
    pub(crate) use_system: bool,
}

pub(crate) const TRANSCRIPTION_SOURCE_MICROPHONE: &str = "microphone";
pub(crate) const TRANSCRIPTION_SOURCE_SYSTEM_AUDIO: &str = "system_audio";
pub(crate) const ERROR_INVALID_TRANSCRIPTION_SOURCE: &str =
    "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。";
pub(crate) const ERROR_APPLE_SPEECH_MULTIPLE_STREAMS: &str =
    "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。";
pub(crate) const ERROR_TRANSCRIPTION_AUDIO_SOURCE_UNAVAILABLE: &str =
    "音声ソースが利用可能ではありません。録音を先に開始してください。";
const ERROR_TRANSCRIPTION_MIC_UNAVAILABLE: &str =
    "要求されたマイク音声の文字起こし入力が利用できません。録音を先に開始してください。";
const ERROR_TRANSCRIPTION_SYSTEM_AUDIO_UNAVAILABLE: &str =
    "要求された相手側音声の文字起こし入力が利用できません。相手側音声の取得を先に開始してください。";

pub(crate) fn validate_stream_count_for_engine(
    engine_type: &TranscriptionEngineType,
    stream_count: usize,
) -> Result<(), String> {
    if matches!(engine_type, TranscriptionEngineType::AppleSpeech) && stream_count > 1 {
        return Err(ERROR_APPLE_SPEECH_MULTIPLE_STREAMS.to_string());
    }
    Ok(())
}

pub(crate) fn validate_requested_sources_available(
    requested: RequestedTranscriptionSources,
    mic_available: bool,
    system_available: bool,
) -> Result<(), String> {
    let mic_missing = requested.use_mic && !mic_available;
    let system_missing = requested.use_system && !system_available;
    match (mic_missing, system_missing) {
        (false, false) => Ok(()),
        (true, true) => Err(ERROR_TRANSCRIPTION_AUDIO_SOURCE_UNAVAILABLE.to_string()),
        (true, false) => Err(ERROR_TRANSCRIPTION_MIC_UNAVAILABLE.to_string()),
        (false, true) => Err(ERROR_TRANSCRIPTION_SYSTEM_AUDIO_UNAVAILABLE.to_string()),
    }
}

pub(crate) fn parse_requested_transcription_sources(
    source: Option<&str>,
) -> Result<RequestedTranscriptionSources, String> {
    let source = source.unwrap_or("both").trim();
    match source {
        TRANSCRIPTION_SOURCE_MICROPHONE => Ok(RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        }),
        TRANSCRIPTION_SOURCE_SYSTEM_AUDIO => Ok(RequestedTranscriptionSources {
            use_mic: false,
            use_system: true,
        }),
        "both" => Ok(RequestedTranscriptionSources {
            use_mic: true,
            use_system: true,
        }),
        _ => Err(ERROR_INVALID_TRANSCRIPTION_SOURCE.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_source_constants_are_snake_case_lowercase() {
        assert_eq!(TRANSCRIPTION_SOURCE_MICROPHONE, "microphone");
        assert_eq!(TRANSCRIPTION_SOURCE_SYSTEM_AUDIO, "system_audio");
    }

    #[test]
    fn test_parse_requested_transcription_sources_accepts_known_values() {
        assert_eq!(
            parse_requested_transcription_sources(None).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" both ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some("microphone")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some("system_audio")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: false,
                use_system: true,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" microphone ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" system_audio ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: false,
                use_system: true,
            }
        );
    }

    #[test]
    fn test_parse_requested_transcription_sources_rejects_unknown_values() {
        for source in ["", " ", "mic", "system", "both,microphone"] {
            let error = parse_requested_transcription_sources(Some(source))
                .expect_err("unknown source should be rejected");
            assert!(
                error.contains("文字起こしソースが不正です"),
                "unexpected error for {source:?}: {error}"
            );
            assert!(
                error.contains("microphone")
                    && error.contains("system_audio")
                    && error.contains("both"),
                "error should list accepted source values: {error}"
            );
        }
    }

    #[test]
    fn test_apple_speech_rejects_multiple_available_streams() {
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            2,
        )
        .unwrap_err();
        assert!(err.contains("Apple SpeechAnalyzer"));
        assert!(err.contains("同時文字起こし"));
    }

    #[test]
    fn test_apple_speech_allows_single_available_stream() {
        validate_stream_count_for_engine(&crate::settings::TranscriptionEngineType::AppleSpeech, 1)
            .expect("single Apple Speech stream should be allowed");
    }

    #[test]
    fn test_other_engines_allow_multiple_available_streams() {
        for engine in [
            crate::settings::TranscriptionEngineType::Whisper,
            crate::settings::TranscriptionEngineType::OpenAIRealtime,
            crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
        ] {
            validate_stream_count_for_engine(&engine, 2)
                .expect("non Apple Speech engines should keep dual stream support");
        }
    }

    #[test]
    fn validate_requested_sources_available_accepts_requested_sources() {
        validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            },
            true,
            false,
        )
        .expect("mic-only request should pass when mic is available");
        validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: false,
                use_system: true,
            },
            false,
            true,
        )
        .expect("system-only request should pass when system audio is available");
        validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            true,
            true,
        )
        .expect("both request should pass when both sources are available");
    }

    #[test]
    fn validate_requested_sources_available_rejects_missing_microphone() {
        let err = validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            },
            false,
            true,
        )
        .expect_err("mic-only request should fail when mic is unavailable");
        assert!(
            err.contains("マイク"),
            "error should identify missing microphone source: {err}"
        );
    }

    #[test]
    fn validate_requested_sources_available_rejects_missing_system_audio() {
        let err = validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: false,
                use_system: true,
            },
            true,
            false,
        )
        .expect_err("system-only request should fail when system audio is unavailable");
        assert!(
            err.contains("相手側音声"),
            "error should identify missing system audio source: {err}"
        );
    }

    #[test]
    fn validate_requested_sources_available_rejects_partial_both_requests() {
        let missing_mic = validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            false,
            true,
        )
        .expect_err("both request should fail when mic is unavailable");
        assert!(
            missing_mic.contains("マイク"),
            "error should identify missing microphone source: {missing_mic}"
        );

        let missing_system = validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            true,
            false,
        )
        .expect_err("both request should fail when system audio is unavailable");
        assert!(
            missing_system.contains("相手側音声"),
            "error should identify missing system audio source: {missing_system}"
        );
    }

    #[test]
    fn validate_requested_sources_available_rejects_all_missing_sources() {
        let err = validate_requested_sources_available(
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            false,
            false,
        )
        .expect_err("both request should fail when no requested source is available");
        assert_eq!(err, ERROR_TRANSCRIPTION_AUDIO_SOURCE_UNAVAILABLE);
    }

    #[test]
    fn parse_requested_transcription_sources_returns_exact_error_message_for_unknown_value() {
        let err = parse_requested_transcription_sources(Some("xyz"))
            .expect_err("unknown source should be rejected");
        assert_eq!(err, ERROR_INVALID_TRANSCRIPTION_SOURCE);
    }

    #[test]
    fn parse_requested_transcription_sources_rejects_uppercase_known_values() {
        for source in ["BOTH", "Microphone", "System_Audio", "Both"] {
            let err = parse_requested_transcription_sources(Some(source))
                .expect_err("uppercase source should be rejected");
            assert_eq!(
                err, ERROR_INVALID_TRANSCRIPTION_SOURCE,
                "unexpected error for {source:?}"
            );
        }
    }

    #[test]
    fn parse_requested_transcription_sources_error_message_contains_source_constants() {
        let err = parse_requested_transcription_sources(Some("xyz"))
            .expect_err("unknown source should be rejected");
        assert!(
            err.contains(TRANSCRIPTION_SOURCE_MICROPHONE),
            "error message should contain TRANSCRIPTION_SOURCE_MICROPHONE ({TRANSCRIPTION_SOURCE_MICROPHONE:?}): {err:?}"
        );
        assert!(
            err.contains(TRANSCRIPTION_SOURCE_SYSTEM_AUDIO),
            "error message should contain TRANSCRIPTION_SOURCE_SYSTEM_AUDIO ({TRANSCRIPTION_SOURCE_SYSTEM_AUDIO:?}): {err:?}"
        );
    }

    // --- validate_stream_count_for_engine boundary + 文言完全一致 ---

    #[test]
    fn validate_stream_count_for_engine_apple_speech_rejects_two_with_exact_error_message() {
        // 既存テストは contains 部分一致のみ。完全一致で UI 文言契約を固定する
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            2,
        )
        .unwrap_err();
        assert_eq!(
            err, ERROR_APPLE_SPEECH_MULTIPLE_STREAMS,
            "クラッシュ防止の UI 文言を完全一致で固定 (UI/log 文言契約)"
        );
    }

    #[test]
    fn validate_stream_count_for_engine_apple_speech_rejects_three_streams_with_same_error_message()
    {
        // stream_count=3 でも 2 と同じエラー文言で reject される (`stream_count > 1` の boundary 挙動)
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            3,
        )
        .unwrap_err();
        assert_eq!(
            err,
            ERROR_APPLE_SPEECH_MULTIPLE_STREAMS,
            "stream_count=3 でも 2 と同じエラー文言で reject される (`stream_count > 1` の boundary 挙動)"
        );
    }

    #[test]
    fn validate_stream_count_for_engine_apple_speech_rejects_usize_max_streams() {
        // usize::MAX boundary でも overflow なく `stream_count > 1` 条件が成立し reject される現契約
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            usize::MAX,
        )
        .unwrap_err();
        assert!(
            err.contains("Apple SpeechAnalyzer"),
            "usize::MAX boundary でも reject される (overflow ガードなしの現契約)"
        );
    }

    #[test]
    fn validate_stream_count_for_engine_apple_speech_allows_zero_streams() {
        // boundary 下限 (0 streams) は `> 1` 条件不成立で Apple Speech でも Ok を返す現契約
        // 既存テストは stream_count=1。0 は boundary の反対側
        validate_stream_count_for_engine(&crate::settings::TranscriptionEngineType::AppleSpeech, 0)
            .expect("stream_count=0 は `> 1` 条件不成立で Apple Speech でも Ok を返す現契約");
    }

    #[test]
    fn validate_stream_count_for_engine_other_engines_allow_zero_and_usize_max_streams() {
        // 既存テストは stream_count=2 のみ。0 と usize::MAX boundary を 3 engine × 2 値で固定
        for engine in [
            crate::settings::TranscriptionEngineType::Whisper,
            crate::settings::TranscriptionEngineType::OpenAIRealtime,
            crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
        ] {
            validate_stream_count_for_engine(&engine, 0)
                .expect("Apple Speech 以外は 0 streams でも Ok を返す現契約");
            validate_stream_count_for_engine(&engine, usize::MAX)
                .expect("Apple Speech 以外は usize::MAX streams でも Ok を返す現契約");
        }
    }

    #[test]
    fn parse_requested_transcription_sources_trims_tab_and_newline_whitespace() {
        // 既存 test_parse_requested_transcription_sources_accepts_known_values は
        // ASCII 半角 SP の前後 trim のみカバー。
        // タブ (\t) と改行 (\n) も str::trim() 対象 (ASCII whitespace) であることを CI 固定。
        // trim_matches(' ') 等の限定 trim への誤改修を検知する装置。
        assert_eq!(
            parse_requested_transcription_sources(Some("\tmicrophone\n")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            },
            "タブと改行も str::trim() で除去される (ASCII whitespace 全般)"
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" \t\nboth\n\t ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            "複数種類の ASCII whitespace 混在も全て trim される"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_trims_unicode_full_width_space_u3000() {
        // Rust の str::trim() は Unicode White_Space プロパティ (UCD) に従い、
        // U+3000 (全角空白) も削除する。
        // 既存 test は U+3000 trim を未保護 = 将来 trim_ascii() 等への変更で挙動変わる。
        // 現契約 (Unicode whitespace 全般を trim) を CI 固定する装置。
        assert_eq!(
            parse_requested_transcription_sources(Some("\u{3000}microphone\u{3000}")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            },
            "U+3000 (全角空白) も str::trim() で除去される現契約 (Unicode White_Space 準拠)"
        );
        assert_eq!(
            parse_requested_transcription_sources(Some("\u{3000}\u{3000}both\u{3000}\u{3000}"))
                .unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            "複数の U+3000 連続も全て trim される"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_rejects_prefix_extension_inputs() {
        // 既存 rejects_unknown_values は "mic" / "system" 等の短縮形のみカバー。
        // "microphone_extra" / "both_only" のような prefix が known value と一致するが
        // suffix が付いた拡張入力は未保護。match 完全一致仕様 (= starts_with でない) を
        // CI 固定する装置 = `starts_with` / `contains` 化への誤改修を検知。
        for source in [
            "microphone_extra",
            "system_audio_full",
            "both_only",
            "microphoneX",
        ] {
            let err = parse_requested_transcription_sources(Some(source))
                .expect_err("prefix 一致のみの拡張入力は reject されるべき");
            assert_eq!(
                err, ERROR_INVALID_TRANSCRIPTION_SOURCE,
                "prefix 拡張入力 {source:?} は完全一致 match を通らず reject される現契約"
            );
        }
    }

    #[test]
    fn requested_transcription_sources_debug_output_contains_struct_name_and_both_field_names() {
        let both = RequestedTranscriptionSources {
            use_mic: true,
            use_system: true,
        };
        let s_both = format!("{:?}", both);
        assert!(
            s_both.contains("RequestedTranscriptionSources"),
            "Debug should contain type name: {}",
            s_both
        );
        assert!(
            s_both.contains("use_mic"),
            "Debug should contain field 'use_mic': {}",
            s_both
        );
        assert!(
            s_both.contains("use_system"),
            "Debug should contain field 'use_system': {}",
            s_both
        );
        assert!(
            s_both.contains("true"),
            "both-true Debug should contain 'true': {}",
            s_both
        );

        let neither = RequestedTranscriptionSources {
            use_mic: false,
            use_system: false,
        };
        let s_neither = format!("{:?}", neither);
        assert!(
            s_neither.contains("RequestedTranscriptionSources"),
            "Debug should contain type name: {}",
            s_neither
        );
        assert!(
            s_neither.contains("use_mic"),
            "Debug should contain field 'use_mic': {}",
            s_neither
        );
        assert!(
            s_neither.contains("use_system"),
            "Debug should contain field 'use_system': {}",
            s_neither
        );
        assert!(
            s_neither.contains("false"),
            "both-false Debug should contain 'false': {}",
            s_neither
        );

        let mic_only = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let s_mic = format!("{:?}", mic_only);
        assert!(
            s_mic.contains("true"),
            "mic-only Debug should contain 'true': {}",
            s_mic
        );
        assert!(
            s_mic.contains("false"),
            "mic-only Debug should contain 'false': {}",
            s_mic
        );
    }

    #[test]
    fn requested_transcription_sources_copy_semantics_allow_use_after_move() {
        let original = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let copied = original;
        assert!(
            original.use_mic,
            "original.use_mic should still be readable (Copy)"
        );
        assert!(
            !original.use_system,
            "original.use_system should still be readable (Copy)"
        );
        assert!(copied.use_mic, "copied.use_mic should match");
        assert!(!copied.use_system, "copied.use_system should match");
    }

    #[test]
    fn requested_transcription_sources_partial_eq_holds_reflexive_and_differs_for_each_field() {
        let a = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let same = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let mic_diff = RequestedTranscriptionSources {
            use_mic: false,
            use_system: false,
        };
        let system_diff = RequestedTranscriptionSources {
            use_mic: true,
            use_system: true,
        };
        let both_diff = RequestedTranscriptionSources {
            use_mic: false,
            use_system: true,
        };

        assert_eq!(a, same, "same field values should be equal");
        assert_ne!(a, mic_diff, "differs by use_mic");
        assert_ne!(a, system_diff, "differs by use_system");
        assert_ne!(a, both_diff, "differs by both");
    }
}
