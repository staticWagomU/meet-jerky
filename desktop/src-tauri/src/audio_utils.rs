//! 音声サンプル処理の共通ユーティリティ。
//!
//! `audio.rs` と `system_audio.rs` で重複していた sanitize 処理を集約する。

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

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

// ─────────────────────────────────────────────
// リサンプリング
// ─────────────────────────────────────────────

/// リサンプラーのチャンクサイズ（入力フレーム数）
pub(crate) const RESAMPLE_CHUNK_SIZE: usize = 1024;

/// リサンプリング用の共通パラメータを返す
pub(crate) fn sinc_params() -> SincInterpolationParameters {
    SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    }
}

/// オーディオサンプルを source_rate から target_rate にリサンプルする。
///
/// rubato の SincFixedIn を使用した高品質なリサンプリングを行う。
/// source_rate == target_rate の場合はコピーを返し、空入力には空出力を返す。
#[allow(dead_code)]
pub(crate) fn resample_audio(
    samples: &[f32],
    source_rate: u32,
    target_rate: u32,
) -> Result<Vec<f32>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    if source_rate == target_rate {
        return Ok(samples.to_vec());
    }

    let mut resampler = SincFixedIn::<f32>::new(
        target_rate as f64 / source_rate as f64,
        2.0,
        sinc_params(),
        RESAMPLE_CHUNK_SIZE,
        1, // モノラル
    )
    .map_err(|e| format!("リサンプラーの作成に失敗しました: {e}"))?;

    let mut output = Vec::new();
    let mut pos = 0;

    loop {
        let frames_needed = resampler.input_frames_next();
        if pos >= samples.len() {
            break;
        }

        let end = (pos + frames_needed).min(samples.len());
        let mut input_chunk: Vec<f32> = samples[pos..end].to_vec();
        let was_padded = input_chunk.len() < frames_needed;

        // 最後のチャンクがフレーム数に満たない場合はゼロパディング
        if was_padded {
            input_chunk.resize(frames_needed, 0.0);
        }

        let input_refs: Vec<&[f32]> = vec![&input_chunk];
        match resampler.process(&input_refs, None) {
            Ok(result) => {
                if let Some(channel) = result.first() {
                    output.extend_from_slice(channel);
                }
            }
            Err(e) => return Err(format!("リサンプリングエラー: {e}")),
        }

        pos = end;

        // ゼロパディングした場合は最後のチャンクなのでループ終了
        if was_padded {
            break;
        }
    }

    // 入力長に基づいた期待出力長でトリミング
    let expected_len =
        (samples.len() as f64 * target_rate as f64 / source_rate as f64).round() as usize;
    output.truncate(expected_len);

    Ok(output)
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

    // ─────────────────────────────────────────
    // resample_audio テスト
    // ─────────────────────────────────────────

    #[test]
    fn test_resample_same_rate() {
        // 16kHz -> 16kHz: 同一レートではそのままコピーが返る
        let input: Vec<f32> = (0..1600).map(|i| (i as f32 / 1600.0).sin()).collect();
        let output = resample_audio(&input, 16000, 16000).unwrap();
        assert_eq!(output.len(), input.len());
        assert_eq!(output, input);
    }

    #[test]
    fn test_resample_downsample_length() {
        // 48kHz -> 16kHz: サンプル数がおよそ 1/3 になる
        let input: Vec<f32> = vec![0.0; 48000]; // 1秒分 @ 48kHz
        let output = resample_audio(&input, 48000, 16000).unwrap();
        // リサンプラーのエッジ効果を許容
        assert!(
            (output.len() as f32 - 16000.0).abs() < 200.0,
            "Expected ~16000 samples, got {}",
            output.len()
        );
    }

    #[test]
    fn test_resample_empty_input() {
        let output = resample_audio(&[], 48000, 16000).unwrap();
        assert!(output.is_empty());
    }

    #[test]
    fn test_resample_preserves_silence() {
        // 無音入力は無音出力になるべき
        let input: Vec<f32> = vec![0.0; 4800];
        let output = resample_audio(&input, 48000, 16000).unwrap();
        assert!(
            output.iter().all(|&s| s.abs() < 0.001),
            "Silent input should produce silent output, max abs value: {}",
            output.iter().map(|s| s.abs()).fold(0.0f32, f32::max)
        );
    }

    // ─────────────────────────────────────────
    // 沈黙検知ロジック テスト (transcription.rs から移動 = locality 回復、Loop 42)
    // ─────────────────────────────────────────

    use crate::transcription::{
        MIN_FLUSH_SAMPLES, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS,
    };

    #[test]
    fn test_calculate_rms_empty_slice_returns_zero() {
        assert_eq!(calculate_rms(&[]), 0.0);
    }

    #[test]
    fn test_calculate_rms_silence_signal_below_threshold() {
        let samples = vec![0.0001_f32; 16000]; // -80dBFS 相当
        let rms = calculate_rms(&samples);
        assert!(
            rms < SILENCE_THRESHOLD_RMS,
            "rms={rms} should be below SILENCE_THRESHOLD_RMS={SILENCE_THRESHOLD_RMS}"
        );
    }

    #[test]
    fn test_calculate_rms_voice_signal_above_threshold() {
        let samples = vec![0.1_f32; 16000]; // -20dBFS 相当
        let rms = calculate_rms(&samples);
        assert!(
            rms > SILENCE_THRESHOLD_RMS,
            "rms={rms} should be above SILENCE_THRESHOLD_RMS={SILENCE_THRESHOLD_RMS}"
        );
    }

    #[test]
    fn test_is_tail_silent_returns_false_when_buffer_too_short() {
        // buffer.len() < lookback の場合は誤検知防止のため false を返す
        let buffer = vec![0.0001_f32; SILENCE_LOOKBACK_SAMPLES - 1];
        assert!(
            !is_tail_silent(&buffer, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS),
            "buffer shorter than lookback should return false"
        );
    }

    #[test]
    fn test_is_tail_silent_detects_voice_then_silence_pattern() {
        // 1 秒の音声 (-20dBFS) + 0.5 秒の沈黙 (-80dBFS)
        let mut buffer = vec![0.1_f32; MIN_FLUSH_SAMPLES];
        buffer.extend(vec![0.0001_f32; SILENCE_LOOKBACK_SAMPLES]);
        assert!(
            is_tail_silent(&buffer, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS),
            "tail silence should be detected in voice+silence pattern"
        );
    }

    #[test]
    fn test_is_tail_silent_rejects_voice_then_voice() {
        // 全部音声レベル (0.1) では沈黙と判定されないこと
        let buffer = vec![0.1_f32; MIN_FLUSH_SAMPLES + SILENCE_LOOKBACK_SAMPLES];
        assert!(
            !is_tail_silent(&buffer, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS),
            "all-voice buffer should not be detected as silent"
        );
    }
}
