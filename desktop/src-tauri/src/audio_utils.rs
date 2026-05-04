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

// ─────────────────────────────────────────────
// 沈黙検知ユーティリティ (純粋関数)
// ─────────────────────────────────────────────

/// `samples` の RMS (Root Mean Square) を計算する。空 slice では 0.0 を返す。
pub(crate) fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// `buffer` の末尾 `lookback` サンプルの RMS が `threshold` 以下なら true を返す。
/// `buffer.len() < lookback` の場合は判定不可とみなして false を返す (誤って早期 flush しない安全側)。
pub(crate) fn is_tail_silent(buffer: &[f32], lookback: usize, threshold: f32) -> bool {
    if buffer.len() < lookback {
        return false;
    }
    let tail = &buffer[buffer.len() - lookback..];
    calculate_rms(tail) <= threshold
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

    #[test]
    fn sanitize_audio_sample_passes_through_negative_zero_preserving_bit_pattern() {
        let result = sanitize_audio_sample(-0.0_f32);
        assert_eq!(result, 0.0_f32);
        assert_eq!(
            result.to_bits(),
            (-0.0_f32).to_bits(),
            "negative zero must preserve bit pattern (sign bit) through sanitize"
        );
    }

    #[test]
    fn sanitize_audio_sample_clamps_f32_max_to_one_and_f32_min_finite_to_minus_one() {
        assert_eq!(
            sanitize_audio_sample(f32::MAX),
            1.0,
            "f32::MAX is finite (not Inf) so clamp must reduce to 1.0"
        );
        assert_eq!(
            sanitize_audio_sample(f32::MIN),
            -1.0,
            "f32::MIN (= -f32::MAX) is finite (not -Inf) so clamp must reduce to -1.0"
        );
    }

    #[test]
    fn sanitize_audio_sample_passes_through_subnormal_min_positive_without_flush_to_zero() {
        let subnormal = f32::MIN_POSITIVE;
        let result = sanitize_audio_sample(subnormal);
        assert_eq!(
            result,
            subnormal,
            "f32::MIN_POSITIVE (smallest normal positive) is in [-1.0, 1.0] so must passthrough without flush-to-zero"
        );
    }
}
