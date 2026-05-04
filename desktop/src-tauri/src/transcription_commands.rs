use tauri::Emitter;

use crate::transcription_model_manager::ModelManager;
use crate::transcription_types::ModelInfo;

/// 利用可能なモデル一覧を返す
#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    ModelManager::list_available_models()
}

/// モデルがダウンロード済みかを確認する
#[tauri::command]
pub fn is_model_downloaded(model_name: String) -> bool {
    let manager = ModelManager::new();
    manager.is_model_downloaded(&model_name)
}

/// `model-download-progress` イベントの payload を組み立てる（純粋関数）
pub(crate) fn build_download_progress_payload(progress: f64, model: &str) -> serde_json::Value {
    serde_json::json!({ "progress": progress, "model": model })
}

/// `model-download-error` イベントの payload を組み立てる（純粋関数）
pub(crate) fn build_download_error_payload(model: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "model": model, "message": message })
}

/// モデルをダウンロードする（プログレスイベントを送信）
///
/// 失敗時は Result で Err を返すことに加え、`model-download-error` を emit する。
/// 既存の `invoke` catch 経路に加えて listen 側でも統一的にハンドリングできるようにする。
#[tauri::command]
pub async fn download_model(model_name: String, app: tauri::AppHandle) -> Result<String, String> {
    let model_name_for_progress = model_name.clone();
    let app_for_progress = app.clone();

    // ダウンロードはブロッキングI/Oなので専用スレッドで実行
    let join_result = tokio::task::spawn_blocking(move || {
        let manager = ModelManager::new();
        let model_name_ref = model_name_for_progress.clone();
        manager.download_model(&model_name_for_progress, move |progress| {
            let _ = app_for_progress.emit(
                "model-download-progress",
                build_download_progress_payload(progress, &model_name_ref),
            );
        })
    })
    .await
    .map_err(|e| format!("ダウンロードタスクの実行に失敗しました: {e}"));

    match join_result {
        Ok(Ok(path)) => Ok(path.to_string_lossy().to_string()),
        Ok(Err(msg)) => {
            let _ = app.emit(
                "model-download-error",
                build_download_error_payload(&model_name, &msg),
            );
            Err(msg)
        }
        Err(msg) => {
            let _ = app.emit(
                "model-download-error",
                build_download_error_payload(&model_name, &msg),
            );
            Err(msg)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RequestedTranscriptionSources {
    pub(crate) use_mic: bool,
    pub(crate) use_system: bool,
}

pub(crate) const TRANSCRIPTION_SOURCE_MICROPHONE: &str = "microphone";
pub(crate) const TRANSCRIPTION_SOURCE_SYSTEM_AUDIO: &str = "system_audio";

pub(crate) fn validate_stream_count_for_engine(
    engine_type: &crate::settings::TranscriptionEngineType,
    stream_count: usize,
) -> Result<(), String> {
    if matches!(
        engine_type,
        crate::settings::TranscriptionEngineType::AppleSpeech
    ) && stream_count > 1
    {
        return Err(
            "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。"
                .to_string(),
        );
    }
    Ok(())
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
        _ => Err(
            "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。"
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_download_progress_payload_serialization() {
        // 既存 progress イベントの payload 形を固定化（回帰防止）。
        // 型側 DownloadProgressPayload { progress, model } と噛み合う形を保証する。
        let payload = build_download_progress_payload(0.5, "small");
        let s = payload.to_string();
        assert!(s.contains("\"progress\":0.5"), "got: {s}");
        assert!(s.contains("\"model\":\"small\""), "got: {s}");
    }

    #[test]
    fn test_download_error_payload_serialization() {
        // model-download-error の payload は { model, message } のフラットキー。
        // TypeScript 側 DownloadErrorPayload と噛み合う形を保証する。
        let payload = build_download_error_payload("small", "HTTP 404");
        let s = payload.to_string();
        assert!(s.contains("\"model\":\"small\""), "got: {s}");
        assert!(s.contains("\"message\":\"HTTP 404\""), "got: {s}");
    }

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
    fn parse_requested_transcription_sources_returns_exact_error_message_for_unknown_value() {
        let err = parse_requested_transcription_sources(Some("xyz"))
            .expect_err("unknown source should be rejected");
        assert_eq!(
            err,
            "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_rejects_uppercase_known_values() {
        for source in ["BOTH", "Microphone", "System_Audio", "Both"] {
            let err = parse_requested_transcription_sources(Some(source))
                .expect_err("uppercase source should be rejected");
            assert_eq!(
                err,
                "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。",
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
            err,
            "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。",
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
            "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。",
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
                err,
                "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。",
                "prefix 拡張入力 {source:?} は完全一致 match を通らず reject される現契約"
            );
        }
    }
}
