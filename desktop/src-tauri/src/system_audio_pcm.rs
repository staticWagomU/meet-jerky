//! ScreenCaptureKit から渡される interleaved f32 PCM bytes を mono f32 サンプル列へ変換する純粋関数群。
//!
//! `system_audio.rs` の ScreenCaptureKitCapture 入力処理から PCM 変換軸を切り出して
//! cfg(target_os) なしで unit test 可能な機能境界に分離する。
//!
//! `read_f32_ne` / `sanitize_pcm_sample` は内部 helper、
//! `f32_pcm_bytes_to_mono` のみ system_audio.rs から呼ばれるため `pub(crate)` で公開する。

use crate::audio_utils::sanitize_audio_sample;

const F32_SAMPLE_BYTES: usize = std::mem::size_of::<f32>();

fn read_f32_ne(sample_bytes: &[u8]) -> f32 {
    f32::from_ne_bytes([
        sample_bytes[0],
        sample_bytes[1],
        sample_bytes[2],
        sample_bytes[3],
    ])
}

fn sanitize_pcm_sample(sample: f32) -> f32 {
    sanitize_audio_sample(sample)
}

pub(crate) fn f32_pcm_bytes_to_mono(data: &[u8], channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }

    let Some(frame_byte_len) = channels.checked_mul(F32_SAMPLE_BYTES) else {
        return Vec::new();
    };

    if channels == 1 {
        return data
            .chunks_exact(F32_SAMPLE_BYTES)
            .map(read_f32_ne)
            .map(sanitize_pcm_sample)
            .collect();
    }

    data.chunks_exact(frame_byte_len)
        .map(|frame| {
            let sum = frame
                .chunks_exact(F32_SAMPLE_BYTES)
                .take(channels)
                .map(read_f32_ne)
                .map(sanitize_pcm_sample)
                .sum::<f32>();
            sum / channels as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm_bytes(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_ne_bytes())
            .collect()
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_keeps_mono_samples() {
        let data = pcm_bytes(&[0.25, -0.5, 1.0]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 1), vec![0.25, -0.5, 1.0]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_downmixes_stereo_frames() {
        let data = pcm_bytes(&[1.0, -1.0, 0.25, 0.75]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 2), vec![0.0, 0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_downmixes_multichannel_frames() {
        let data = pcm_bytes(&[1.0, 0.5, -0.5, 0.25, 0.25, 1.0]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 3), vec![1.0 / 3.0, 0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_ignores_zero_channels() {
        let data = pcm_bytes(&[1.0, -1.0]);

        assert!(f32_pcm_bytes_to_mono(&data, 0).is_empty());
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_ignores_short_and_trailing_bytes() {
        assert!(f32_pcm_bytes_to_mono(&[1, 2, 3], 1).is_empty());

        let mut data = pcm_bytes(&[0.5]);
        data.extend_from_slice(&[9, 8, 7]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 1), vec![0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_ignores_partial_multichannel_frame() {
        let mut data = pcm_bytes(&[0.25, 0.75, 1.0]);
        data.extend_from_slice(&[9, 8]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 2), vec![0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_sanitizes_invalid_samples() {
        let data = pcm_bytes(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 2.0, -2.0]);

        assert_eq!(
            f32_pcm_bytes_to_mono(&data, 1),
            vec![0.0, 0.0, 0.0, 1.0, -1.0]
        );
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_sanitizes_before_downmix() {
        let data = pcm_bytes(&[f32::NAN, 1.0, 2.0, -2.0]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 2), vec![0.5, 0.0]);
    }

    // ── sanitize_pcm_sample 直接呼び出しテスト ─────────────────────────────

    #[test]
    fn sanitize_pcm_sample_returns_zero_for_nan() {
        assert_eq!(sanitize_pcm_sample(f32::NAN), 0.0);
    }

    #[test]
    fn sanitize_pcm_sample_returns_zero_for_positive_infinity() {
        assert_eq!(sanitize_pcm_sample(f32::INFINITY), 0.0);
    }

    #[test]
    fn sanitize_pcm_sample_returns_zero_for_negative_infinity() {
        assert_eq!(sanitize_pcm_sample(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn sanitize_pcm_sample_clamps_above_one_to_one() {
        assert_eq!(sanitize_pcm_sample(1.5), 1.0);
    }

    #[test]
    fn sanitize_pcm_sample_clamps_below_minus_one_to_minus_one() {
        assert_eq!(sanitize_pcm_sample(-1.5), -1.0);
    }

    #[test]
    fn sanitize_pcm_sample_passes_through_finite_values_in_range() {
        assert_eq!(sanitize_pcm_sample(0.0), 0.0);
        assert_eq!(sanitize_pcm_sample(0.5), 0.5);
        assert_eq!(sanitize_pcm_sample(-0.5), -0.5);
        assert_eq!(sanitize_pcm_sample(1.0), 1.0);
        assert_eq!(sanitize_pcm_sample(-1.0), -1.0);
    }

    // ── read_f32_ne bit-pattern 直接テスト ───────────────────────────────────

    #[test]
    fn read_f32_ne_decodes_zero_bytes_to_zero_float() {
        // 4 byte 全 0 は f32 では 0.0 (どの endian でも符号なし)。
        // bit-pattern 読み取りの基本契約を固定する。
        let bytes = [0u8; 4];
        assert_eq!(read_f32_ne(&bytes), 0.0);
    }

    #[test]
    fn read_f32_ne_round_trips_one_point_zero() {
        // f32::to_ne_bytes と read_f32_ne (= f32::from_ne_bytes) の双方向 round-trip を確認。
        // from_le_bytes / from_be_bytes への誤リファクタを native endian 環境で検知する
        // (multibyte cross-platform でも to_ne_bytes ↔ from_ne_bytes は常に round-trip 不変)。
        let original: f32 = 1.0;
        let bytes = original.to_ne_bytes();
        assert_eq!(read_f32_ne(&bytes), original);
    }

    #[test]
    fn read_f32_ne_decodes_nan_bit_pattern_to_nan() {
        // NaN の bit-pattern は f32::NAN.to_ne_bytes() で取得し、read 結果が is_nan() を満たす。
        // sanitize_pcm_sample の前段で NaN bit-pattern が正しく NaN として読まれることが
        // 間接テストでは保証されない (sanitize で 0.0 に潰されてしまうため)。直接テストで保護。
        let bytes = f32::NAN.to_ne_bytes();
        assert!(read_f32_ne(&bytes).is_nan());
    }

    #[test]
    fn read_f32_ne_decodes_negative_infinity_bit_pattern() {
        // -Inf の bit-pattern が is_infinite() && is_sign_negative() を満たす。
        // f32 IEEE 754 表現の符号ビット保持を確認 (sanitize 前段の保証)。
        let bytes = f32::NEG_INFINITY.to_ne_bytes();
        let result = read_f32_ne(&bytes);
        assert!(result.is_infinite());
        assert!(result.is_sign_negative());
    }
}
