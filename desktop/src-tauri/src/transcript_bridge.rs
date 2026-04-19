//! ライブ文字起こしの `TranscriptionSegment` を
//! `Session::append_segment` に渡すための純粋な変換ブリッジ。

use crate::transcription::TranscriptionSegment;

/// ライブセグメントから `Session::append_segment` の引数 3 つ組に変換する。
///
/// 戻り値は `(speaker_label, timestamp_offset_secs, text)`。
pub fn segment_to_append_args(
    segment: &TranscriptionSegment,
    session_started_at_secs: u64,
    stream_started_at_secs: u64,
) -> (String, u64, String) {
    let speaker = segment.speaker.clone().unwrap_or_default();
    let segment_offset_from_stream_secs = segment.start_ms.max(0) / 1000;
    let segment_abs_secs =
        stream_started_at_secs.saturating_add(segment_offset_from_stream_secs as u64);
    let offset = segment_abs_secs.saturating_sub(session_started_at_secs);
    (speaker, offset, segment.text.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_segment() -> TranscriptionSegment {
        TranscriptionSegment {
            text: "こんにちは".to_string(),
            start_ms: 2_000,
            end_ms: 3_500,
            speaker: Some("自分".to_string()),
        }
    }

    #[test]
    fn happy_path_forwards_text_and_computes_offset() {
        // セッション開始: 1000s, ストリーム開始: 1040s, セグメント start: 2000ms
        // => セグメント絶対時刻 = 1042s, セッション開始からのオフセット = 42s
        let segment = sample_segment();
        let (speaker, offset, text) = segment_to_append_args(&segment, 1000, 1040);
        assert_eq!(speaker, "自分");
        assert_eq!(offset, 42);
        assert_eq!(text, "こんにちは");
    }
}
