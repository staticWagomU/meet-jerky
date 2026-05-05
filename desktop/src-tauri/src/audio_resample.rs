//! 音声サンプルのサンプリングレート変換 (リサンプリング) ユーティリティ。
//!
//! `audio_utils.rs` から rubato 依存のリサンプリング軸を分離し、
//! 同 file 内に sanitize 軸 (`sanitize_audio_sample`) と共存していた構造を
//! 機能境界で整理する。`resample_audio` は `#[allow(dead_code)]` 付きで
//! 将来用に保持 (production 呼出ゼロ、`sinc_params` / `RESAMPLE_CHUNK_SIZE` のみ
//! `transcription_whisper_stream.rs` から使用)。

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

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
}
