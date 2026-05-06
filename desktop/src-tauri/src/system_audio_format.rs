//! ScreenCaptureKit が配信する音声フォーマット (Float32 / NativeEndian / 32bit / channel count) の検証関数群。
//!
//! `system_audio.rs` の ScreenCaptureKitCapture 入力処理から audio format 検証軸を切り出して
//! 機能境界で分離する。`screencapturekit::CMFormatDescription` への依存を当軸に閉じ込める。
//!
//! `validate_audio_format_properties` は純粋関数 (cfg なし) として unit test 可能。
//! `validate_audio_format_description` は CMFormatDescription を受けるラッパー (cfg(macos) 限定)。

#[cfg(target_os = "macos")]
use screencapturekit::CMFormatDescription;

const ERROR_NON_F32_PCM_FORMAT: &str = "非 f32 PCM フォーマット (kAudioFormatFlagIsFloat 未設定)";

/// フォーマット検証の内部ロジック。純粋関数としてテスト可能。
/// ScreenCaptureKit が配信する Float32 / NativeEndian / 設定チャンネル数を確認する。
fn validate_audio_format_properties(
    is_float: bool,
    is_big_endian: bool,
    bits_per_channel: Option<u32>,
    channel_count: Option<u32>,
    expected_channels: u32,
) -> Result<(), &'static str> {
    if !is_float {
        return Err(ERROR_NON_F32_PCM_FORMAT);
    }
    if is_big_endian {
        return Err("BigEndian フォーマット (NativeEndian が必要)");
    }
    match bits_per_channel {
        Some(32) => {}
        Some(_) => return Err("bits_per_channel が 32 ではない"),
        None => return Err("bits_per_channel を取得できない"),
    }
    match channel_count {
        Some(ch) if ch == expected_channels => {}
        Some(_) => return Err("channel 数が設定値と不一致"),
        None => return Err("channel 数を取得できない"),
    }
    Ok(())
}

/// CMFormatDescription を受け取り ASBD 相当の検証を行う。
/// screencapturekit 1.5 で CMFormatDescription が公開されているため ASBD 検証が可能。
/// crate の音声フォーマット API が変化した場合はここを更新すること。
#[cfg(target_os = "macos")]
pub(crate) fn validate_audio_format_description(
    fmt: &CMFormatDescription,
    expected_channels: u32,
) -> Result<(), &'static str> {
    validate_audio_format_properties(
        fmt.audio_is_float(),
        fmt.audio_is_big_endian(),
        fmt.audio_bits_per_channel(),
        fmt.audio_channel_count(),
        expected_channels,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_audio_format_properties テスト ─────────────────────────────

    #[test]
    fn test_validate_audio_format_valid_f32_native_mono() {
        // Float32 / NativeEndian / 32bit / 1ch (設定値と一致) → Ok
        assert!(
            validate_audio_format_properties(true, false, Some(32), Some(1), 1).is_ok(),
            "正常な f32 モノラルフォーマットは Ok でなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_non_float() {
        // Integer PCM (is_float = false) → Err
        assert!(
            validate_audio_format_properties(false, false, Some(32), Some(1), 1).is_err(),
            "非 float フォーマットは拒否されなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_big_endian() {
        // BigEndian フォーマット → Err (Apple Silicon / Intel は NativeEndian)
        assert!(
            validate_audio_format_properties(true, true, Some(32), Some(1), 1).is_err(),
            "BigEndian フォーマットは拒否されなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_channel_count_mismatch() {
        // ステレオ (2ch) だが設定は 1ch → Err
        assert!(
            validate_audio_format_properties(true, false, Some(32), Some(2), 1).is_err(),
            "channel 数不一致は拒否されなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_unexpected_bits_per_channel() {
        // 16-bit PCM → Err (f32 = 32bit が必須)
        assert!(
            validate_audio_format_properties(true, false, Some(16), Some(1), 1).is_err(),
            "bits_per_channel が 32 以外は拒否されなければならない"
        );
    }

    // ── validate_audio_format_properties 未カバーケース ──────────────────────

    #[test]
    fn validate_audio_format_properties_rejects_when_bits_per_channel_unknown() {
        let result = validate_audio_format_properties(true, false, None, Some(1), 1);
        assert_eq!(result.unwrap_err(), "bits_per_channel を取得できない");
    }

    #[test]
    fn validate_audio_format_properties_rejects_when_channel_count_unknown() {
        let result = validate_audio_format_properties(true, false, Some(32), None, 1);
        assert_eq!(result.unwrap_err(), "channel 数を取得できない");
    }

    // 既存 5 件は is_err() のみでエラー文言未確認。本テストがそれを補強する。
    #[test]
    fn validate_audio_format_properties_error_messages_match_documented_strings_for_known_paths() {
        let non_float = validate_audio_format_properties(false, false, Some(32), Some(1), 1);
        assert_eq!(non_float.unwrap_err(), ERROR_NON_F32_PCM_FORMAT);

        let big_endian = validate_audio_format_properties(true, true, Some(32), Some(1), 1);
        assert_eq!(
            big_endian.unwrap_err(),
            "BigEndian フォーマット (NativeEndian が必要)"
        );

        let wrong_bits = validate_audio_format_properties(true, false, Some(16), Some(1), 1);
        assert_eq!(wrong_bits.unwrap_err(), "bits_per_channel が 32 ではない");

        let channel_mismatch = validate_audio_format_properties(true, false, Some(32), Some(2), 1);
        assert_eq!(channel_mismatch.unwrap_err(), "channel 数が設定値と不一致");
    }

    // ── validate_audio_format_properties short-circuit 順序契約 ──────────────

    #[test]
    fn validate_audio_format_properties_returns_first_violation_when_multiple_invalid() {
        // 4 関門 (is_float / is_big_endian / bits_per_channel / channel_count) すべて violation の場合、
        // 第 1 関門 (is_float check) が最初に発火し "非 f32 PCM..." を返す現挙動を固定。
        // 関門順序の入れ替えリファクタを CI で検知する装置として機能。
        let result = validate_audio_format_properties(
            /* is_float */ false,
            /* is_big_endian */ true,
            /* bits_per_channel */ Some(16),
            /* channel_count */ Some(99),
            /* expected_channels */ 2,
        );

        // 第 1 関門が最優先で発火することを文言完全一致で固定。
        assert_eq!(result, Err(ERROR_NON_F32_PCM_FORMAT));
    }
}
