//! 音声サンプル変換とモノラル化、RMS 計算の純粋ヘルパー。

use cpal::{FromSample, Sample};

pub(crate) fn for_each_mono_sample<T, F>(data: &[T], channels: usize, mut on_sample: F)
where
    T: Copy,
    f32: FromSample<T>,
    F: FnMut(f32),
{
    if channels == 0 {
        return;
    }

    for frame in data.chunks_exact(channels) {
        let mono = frame
            .iter()
            .copied()
            .map(normalize_sample_to_f32)
            .sum::<f32>()
            / frame.len() as f32;
        on_sample(mono);
    }
}

pub(crate) fn normalize_sample_to_f32<T>(sample: T) -> f32
where
    f32: FromSample<T>,
{
    sanitize_sample(f32::from_sample(sample))
}

pub(crate) fn sanitize_sample(sample: f32) -> f32 {
    crate::audio_utils::sanitize_audio_sample(sample)
}

pub(crate) fn calculate_rms_from_sum(sum_squares: f32, sample_count: usize) -> f32 {
    if sample_count == 0 {
        return 0.0;
    }

    let rms = (sum_squares / sample_count as f32).sqrt();
    if rms.is_nan() {
        return 0.0;
    }
    rms.clamp(0.0, 1.0)
}
