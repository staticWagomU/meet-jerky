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
    let speaker = normalize_speaker(segment.speaker.as_deref());
    let segment_offset_from_stream_secs = segment.start_ms.max(0) / 1000;
    let segment_abs_secs =
        stream_started_at_secs.saturating_add(segment_offset_from_stream_secs as u64);
    let offset = segment_abs_secs.saturating_sub(session_started_at_secs);
    (speaker, offset, segment.text.clone())
}

/// 話者ラベルを正規化する。
///
/// - 前後の空白をトリム
/// - `None` または空文字列は `"不明"` にフォールバック
/// - それ以外は受け取った値をそのまま採用（`transcription.rs` 側で
///   既に `"自分"` / `"相手"` が付与されているため）
fn normalize_speaker(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "不明".to_string(),
    }
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
    fn speaker_is_trimmed_and_none_falls_back_to_unknown_label() {
        // None → "不明" にフォールバック（Markdown 仕様で話者欄を埋めるため）
        let seg_none = TranscriptionSegment {
            text: "x".to_string(),
            start_ms: 0,
            end_ms: 0,
            speaker: None,
        };
        let (speaker, _, _) = segment_to_append_args(&seg_none, 1000, 1000);
        assert_eq!(speaker, "不明");

        // 前後の空白はトリムされる
        let seg_ws = TranscriptionSegment {
            text: "x".to_string(),
            start_ms: 0,
            end_ms: 0,
            speaker: Some("  自分  ".to_string()),
        };
        let (speaker, _, _) = segment_to_append_args(&seg_ws, 1000, 1000);
        assert_eq!(speaker, "自分");
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
