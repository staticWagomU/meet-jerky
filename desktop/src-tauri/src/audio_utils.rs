//! 音声サンプル処理の共通ユーティリティ。
//!
//! `audio.rs` と `system_audio.rs` で重複していた sanitize 処理を集約する。

/// 音声サンプル (f32) を正規化する。
///
/// - `NaN` / `±Inf` は 0.0 に置換 (downstream の RMS 計算で NaN 伝播を防ぐ)
/// - 有限値は `[-1.0, 1.0]` の範囲にクランプ
pub fn sanitize_audio_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_audio_sample_returns_zero_for_nan() {
        assert_eq!(sanitize_audio_sample(f32::NAN), 0.0);
    }

    #[test]
    fn sanitize_audio_sample_returns_zero_for_positive_infinity() {
        assert_eq!(sanitize_audio_sample(f32::INFINITY), 0.0);
    }

    #[test]
    fn sanitize_audio_sample_returns_zero_for_negative_infinity() {
        assert_eq!(sanitize_audio_sample(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn sanitize_audio_sample_clamps_above_one_to_one() {
        assert_eq!(sanitize_audio_sample(1.5), 1.0);
    }

    #[test]
    fn sanitize_audio_sample_clamps_below_minus_one_to_minus_one() {
        assert_eq!(sanitize_audio_sample(-1.5), -1.0);
    }

    #[test]
    fn sanitize_audio_sample_passes_through_finite_values_in_range() {
        assert_eq!(sanitize_audio_sample(0.0), 0.0);
        assert_eq!(sanitize_audio_sample(0.5), 0.5);
        assert_eq!(sanitize_audio_sample(-0.5), -0.5);
        assert_eq!(sanitize_audio_sample(1.0), 1.0);
        assert_eq!(sanitize_audio_sample(-1.0), -1.0);
    }
}
