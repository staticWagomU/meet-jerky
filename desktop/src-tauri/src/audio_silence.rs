//! Whisper の沈黙検知ユーティリティ (純粋関数)。
//!
//! `audio_utils.rs` から沈黙判定軸を切り出して機能境界で分離する。
//! Whisper 仕様 const + RMS 計算 + 末尾沈黙判定の責務を集約する。
//! caller は `transcription_whisper_stream.rs` のみ。

use crate::audio::calculate_rms;

/// Whisper の入力サンプルレート (16kHz)。Whisper 仕様で固定。
pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// 早期 flush を許可する最小チャンク長 (1 秒 @ 16kHz)。これ未満では Whisper の精度が落ちるため flush しない。
pub(crate) const MIN_FLUSH_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize; // 16000

/// 末尾の沈黙判定に使うウィンドウ長 (0.5 秒 @ 16kHz)。
pub(crate) const SILENCE_LOOKBACK_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize / 2; // 8000

/// 沈黙とみなす RMS 閾値 (-40dBFS 相当 ≈ 0.01)。実機の背景ノイズで再調整が必要。
/// 調査担当推奨の -60dBFS (= 0.001) は会議室背景ノイズより低く誤判定リスクが大きいため、より安全側を選択。
pub(crate) const SILENCE_THRESHOLD_RMS: f32 = 0.01;

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
