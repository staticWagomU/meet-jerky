use rubato::{Resampler, SincFixedIn};

pub(crate) fn resample_block(
    resampler: &mut Option<SincFixedIn<f32>>,
    buffer: &mut Vec<f32>,
    input: &[f32],
) -> Result<Vec<f32>, String> {
    if let Some(resampler) = resampler {
        buffer.extend_from_slice(input);
        let mut out: Vec<f32> = Vec::new();
        let chunk_size = resampler.input_frames_next();
        while buffer.len() >= chunk_size {
            let chunk: Vec<f32> = buffer.drain(..chunk_size).collect();
            let refs: Vec<&[f32]> = vec![&chunk];
            match resampler.process(&refs, None) {
                Ok(result) => {
                    if let Some(channel) = result.first() {
                        out.extend_from_slice(channel);
                    }
                }
                Err(e) => return Err(format!("リサンプリングエラー: {e}")),
            }
        }
        Ok(out)
    } else {
        Ok(input.to_vec())
    }
}

pub(crate) fn float_to_pcm16(input: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 2);
    for &s in input {
        let clamped = s.clamp(-1.0, 1.0);
        let i = (clamped * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&i.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_to_pcm16_handles_full_range_and_clamping() {
        // 0 / +1 / -1 / クリップ範囲外を PCM16 LE に変換する。
        // PCM16 little-endian の境界値を固定化する。
        let samples = [0.0_f32, 1.0, -1.0, 1.5, -1.5];
        let bytes = float_to_pcm16(&samples);
        assert_eq!(bytes.len(), samples.len() * 2);

        let read = |i: usize| -> i16 { i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]) };
        assert_eq!(read(0), 0);
        assert_eq!(read(1), i16::MAX);
        // -1.0 → -32767 (round). MIN (-32768) ではないことに注意。
        assert_eq!(read(2), -i16::MAX);
        // クリップされる値は端 (i16::MAX / -i16::MAX) になる。
        assert_eq!(read(3), i16::MAX);
        assert_eq!(read(4), -i16::MAX);
    }

    #[test]
    fn float_to_pcm16_empty_input_yields_empty_output() {
        assert!(float_to_pcm16(&[]).is_empty());
    }
}
