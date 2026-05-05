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
    use crate::transcription_commands::RequestedTranscriptionSources;
    use crate::transcription_error_payload::{
        is_realtime_stream_already_stopped_error, should_emit_realtime_stream_error,
    };

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
