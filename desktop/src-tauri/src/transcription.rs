// ─────────────────────────────────────────────
// データ型 (transcription_types.rs に分離、ここから互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

// ─────────────────────────────────────────────
// TranscriptionEngine / TranscriptionStream トレイト (transcription_traits.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};

// ─────────────────────────────────────────────
// WhisperStream (transcription_whisper_stream.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_whisper_stream::WhisperStream;

// ─────────────────────────────────────────────
// TranscriptionManager / TranscriptionStateHandle (transcription_manager.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_manager::TranscriptionStateHandle;

// ─────────────────────────────────────────────
// Tauri コマンド
// ─────────────────────────────────────────────

/// Whisper の入力サンプルレート（16kHz）
pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16_000;

// ─────────────────────────────────────────────
// TranscriptionLoopConfig (transcription_worker_loop.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub(crate) use crate::transcription_worker_loop::TranscriptionLoopConfig;

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription_commands::RequestedTranscriptionSources;
    use crate::transcription_error_payload::{
        is_realtime_stream_already_stopped_error, should_emit_realtime_stream_error,
    };
    use crate::transcription_manager::TranscriptionManager;

    // ─────────────────────────────────────────
    // ensure_engine — エンジン種別ディスパッチ / 再ロード抑制
    // ─────────────────────────────────────────

    #[test]
    fn test_ensure_engine_apple_speech_errors_off_macos() {
        // 非 macOS では AppleSpeech は使えないので明示エラー。
        // Whisper 側の実装に切り替えてくださいというヒント文言を含む。
        // (macOS テスト環境ではこのテストは失敗するので skip する)
        if cfg!(target_os = "macos") {
            return;
        }
        let mut manager = TranscriptionManager::new();
        let err = manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::AppleSpeech,
                "small",
            )
            .unwrap_err();
        assert!(err.contains("macOS"));
    }

    #[test]
    fn test_ensure_engine_openai_loads_engine_without_api_key_check() {
        // OpenAI エンジンは start_stream 時に Keychain から API キーを取得するので、
        // ensure_engine 自体は成功する。実 WebSocket 接続は start_stream まで遅延する。
        let mut manager = TranscriptionManager::new();
        manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::OpenAIRealtime,
                "small",
            )
            .expect("OpenAI エンジンの ensure_engine は同期的には成功する");
        assert!(manager.is_engine_loaded());
    }

    #[test]
    fn test_ensure_engine_elevenlabs_loads_engine_without_api_key_check() {
        // ElevenLabs も start_stream 時に Keychain から API キーを取得する。
        // ensure_engine 自体は課金・通信を発生させず、同期的に成功する。
        let mut manager = TranscriptionManager::new();
        manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
                "small",
            )
            .expect("ElevenLabs エンジンの ensure_engine は同期的には成功する");
        assert!(manager.is_engine_loaded());
    }

    // ─────────────────────────────────────────
    // モデル未ダウンロード エラーパス テスト
    // ─────────────────────────────────────────

    #[test]
    fn load_model_returns_error_when_model_not_downloaded() {
        let mut manager = TranscriptionManager::new();
        let err = manager
            .load_model("__nonexistent_test_model_xyz_999__")
            .unwrap_err();
        assert!(
            err.starts_with("モデルがダウンロードされていません:"),
            "unexpected error: {err}"
        );
        assert!(!manager.is_engine_loaded());
    }

    #[test]
    fn ensure_engine_returns_error_when_whisper_model_not_downloaded() {
        let mut manager = TranscriptionManager::new();
        let err = manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::Whisper,
                "__nonexistent_test_model_xyz_999__",
            )
            .unwrap_err();
        assert!(
            err.starts_with("モデルがダウンロードされていません:"),
            "unexpected error: {err}"
        );
        assert!(!manager.is_engine_loaded());
        // 2 回目も Err: loaded_engine_signature が記録されていないことの間接確認
        let result2 = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__nonexistent_test_model_xyz_999__",
        );
        assert!(result2.is_err());
    }

    #[test]
    fn ensure_engine_does_not_set_engine_on_whisper_failure() {
        let mut manager = TranscriptionManager::new();
        let result = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__nonexistent_test_model_xyz_999__",
        );
        assert!(result.is_err());
        assert!(!manager.is_engine_loaded());
        // 別モデル名でも依然 Err: engine も signature も汚染されていない
        let result2 = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__another_nonexistent_test_model_999__",
        );
        assert!(result2.is_err());
    }

    #[test]
    fn should_emit_realtime_stream_error_is_logical_negation_of_already_stopped() {
        for input in [
            "Realtime ストリームが既に停止しています",
            "リサンプリングエラー: invalid",
            "",
            "Realtime ストリーム",
            "OpenAI Realtime ストリームが既に停止しています extra suffix",
        ] {
            assert_eq!(
                should_emit_realtime_stream_error(input),
                !is_realtime_stream_already_stopped_error(input),
                "symmetry violated for input: {input:?}"
            );
        }
    }

    #[test]
    fn stream_config_debug_output_contains_struct_name_all_four_field_names_with_some_and_none() {
        let config = StreamConfig {
            sample_rate: 44100,
            speaker: Some("自分".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: Some("ja".to_string()),
        };
        let dbg = format!("{:?}", config);
        assert!(
            dbg.contains("StreamConfig"),
            "Debug 出力に型名 StreamConfig が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("sample_rate"),
            "Debug 出力に field 名 sample_rate が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("speaker"),
            "Debug 出力に field 名 speaker が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("source"),
            "Debug 出力に field 名 source が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("language"),
            "Debug 出力に field 名 language が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("44100"),
            "Debug 出力に sample_rate 値 44100 が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("自分"),
            "Debug 出力に speaker 値が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("ja"),
            "Debug 出力に language 値 ja が含まれる: {dbg}"
        );
        assert!(dbg.contains("Some"), "Debug 出力に Some が含まれる: {dbg}");
        assert!(
            dbg.contains("Microphone"),
            "Debug 出力に enum variant 名 Microphone が含まれる: {dbg}"
        );
        let config2 = StreamConfig {
            sample_rate: 0,
            speaker: None,
            source: None,
            language: None,
        };
        let dbg2 = format!("{:?}", config2);
        assert!(
            dbg2.contains("None"),
            "None config の Debug 出力に None が含まれる: {dbg2}"
        );
        assert!(
            dbg2.contains("0"),
            "None config の Debug 出力に sample_rate 値 0 が含まれる: {dbg2}"
        );
    }

    #[test]
    fn stream_config_debug_output_equals_after_clone_for_some_and_none_variants() {
        let c = StreamConfig {
            sample_rate: 48000,
            speaker: Some("相手側".to_string()),
            source: Some(TranscriptionSource::SystemAudio),
            language: Some("en".to_string()),
        };
        assert_eq!(
            format!("{:?}", c),
            format!("{:?}", c.clone()),
            "全 Some config の Debug 出力は clone 後と完全一致する"
        );
        let c2 = StreamConfig {
            sample_rate: 16000,
            speaker: None,
            source: None,
            language: None,
        };
        assert_eq!(
            format!("{:?}", c2),
            format!("{:?}", c2.clone()),
            "全 None config の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn stream_config_clone_produces_independent_copy_for_option_string_fields() {
        let original = StreamConfig {
            sample_rate: 22050,
            speaker: Some("orig_speaker".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: Some("ja".to_string()),
        };
        let mut cloned = original.clone();
        cloned.speaker = Some("mutated_speaker".to_string());
        cloned.source = Some(TranscriptionSource::SystemAudio);
        cloned.language = None;
        cloned.sample_rate = 99999;
        assert_eq!(
            original.sample_rate, 22050,
            "original の sample_rate は cloned mutation 後も不変"
        );
        assert_eq!(
            original.speaker.as_deref(),
            Some("orig_speaker"),
            "original の speaker は cloned mutation 後も不変"
        );
        assert_eq!(
            original.source,
            Some(TranscriptionSource::Microphone),
            "original の source は cloned mutation 後も不変"
        );
        assert_eq!(
            original.language.as_deref(),
            Some("ja"),
            "original の language は cloned mutation 後も不変"
        );
        assert_eq!(
            cloned.sample_rate, 99999,
            "cloned の sample_rate は mutation で 99999 に変わる"
        );
        assert_eq!(cloned.speaker.as_deref(), Some("mutated_speaker"));
        assert_eq!(cloned.source, Some(TranscriptionSource::SystemAudio));
        assert!(
            cloned.language.is_none(),
            "cloned の language は None に変わる"
        );
    }

    #[test]
    fn requested_transcription_sources_debug_output_contains_struct_name_and_both_field_names() {
        // 両 true case
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

        // 両 false case
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

        // 混合 case (mic-only) で true と false が両方とも出ることを確認
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
        // Copy 派生があれば、let copied = original で move されず、original も使える
        let copied = original;
        // original を copied と独立に使えることを確認
        assert!(
            original.use_mic,
            "original.use_mic should still be readable (Copy)"
        );
        assert!(
            !original.use_system,
            "original.use_system should still be readable (Copy)"
        );
        // copied 側も値が独立して使える
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
            use_mic: false, // 違う
            use_system: false,
        };
        let system_diff = RequestedTranscriptionSources {
            use_mic: true,
            use_system: true, // 違う
        };
        let both_diff = RequestedTranscriptionSources {
            use_mic: false,
            use_system: true,
        };

        // reflexive 等値
        assert_eq!(a, same, "same field values should be equal");
        // 片方の field 違いで不等値
        assert_ne!(a, mic_diff, "differs by use_mic");
        assert_ne!(a, system_diff, "differs by use_system");
        // 両 field 違いで不等値
        assert_ne!(a, both_diff, "differs by both");
    }
}
