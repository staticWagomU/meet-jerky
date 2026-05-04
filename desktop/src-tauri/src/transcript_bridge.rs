//! ライブ文字起こしの `TranscriptionSegment` を
//! `Session::append_segment` に渡すための純粋な変換ブリッジ。

use crate::transcription::TranscriptionSegment;

/// ライブセグメントから `Session::append_segment` の引数 3 つ組に変換する。
///
/// 戻り値は `(speaker_label, timestamp_offset_secs, text)`。
#[cfg(test)]
pub fn segment_to_append_args(
    segment: &TranscriptionSegment,
    session_started_at_secs: u64,
    stream_started_at_secs: u64,
) -> (String, u64, String) {
    segment_to_append_args_at(
        segment,
        session_started_at_secs,
        stream_started_at_secs,
        None,
    )
}

/// ライブセグメントから `Session::append_segment` の引数を作る。
///
/// `start_ms` または `end_ms` がある場合はエンジンが持つストリーム相対時刻を優先する。
/// Realtime 系のように確定セグメントが `start_ms = 0, end_ms = 0` で来る場合だけ、
/// 保存時に全行がセッション開始時刻へ潰れないよう、呼び出し側で観測した現在時刻に
/// フォールバックする。
pub fn segment_to_append_args_at(
    segment: &TranscriptionSegment,
    session_started_at_secs: u64,
    stream_started_at_secs: u64,
    observed_at_secs: Option<u64>,
) -> (String, u64, String) {
    let speaker = normalize_speaker(segment.speaker.as_deref());
    let has_engine_timestamp = segment.start_ms > 0 || segment.end_ms > 0;
    let segment_abs_secs = if has_engine_timestamp {
        let segment_offset_from_stream_secs = segment.start_ms.max(0) / 1000;
        stream_started_at_secs.saturating_add(segment_offset_from_stream_secs as u64)
    } else {
        observed_at_secs.unwrap_or(stream_started_at_secs)
    };
    let offset = segment_abs_secs.saturating_sub(session_started_at_secs);
    // 保存前の最小後処理として前後空白だけを落とし、内部表現は保持する。
    let text = segment.text.trim().to_string();
    (speaker, offset, text)
}

/// セグメント emit 直前に、`SessionManager::append` に渡す引数を計算するヘルパー。
///
/// - `session_started_at_secs == None` → `None` を返し、呼び出し側に append をスキップさせる
/// - `segment.is_error == Some(true)` → `None` を返し、UI 用エラーを議事録本文へ保存しない
/// - `Some(started)` → `segment_to_append_args` と同じ 3 つ組を `Some` で返す
///
/// live loop 側の条件分岐をこの純粋関数に閉じ込めることで、
/// 「未開始時やエラー表示時に append を呼ばない」挙動をユニットテストで保証する。
#[cfg(test)]
pub fn build_append_args_for_emission(
    segment: &TranscriptionSegment,
    session_started_at_secs: Option<u64>,
    stream_started_at_secs: u64,
) -> Option<(String, u64, String)> {
    build_append_args_for_emission_at(
        segment,
        session_started_at_secs,
        stream_started_at_secs,
        None,
    )
}

/// `build_append_args_for_emission` の時刻注入版。
///
/// 実運用では `observed_at_secs` に現在時刻を渡し、テストでは固定値を渡せるようにする。
pub fn build_append_args_for_emission_at(
    segment: &TranscriptionSegment,
    session_started_at_secs: Option<u64>,
    stream_started_at_secs: u64,
    observed_at_secs: Option<u64>,
) -> Option<(String, u64, String)> {
    if segment.is_error.unwrap_or(false) {
        return None;
    }
    let started = session_started_at_secs?;
    Some(segment_to_append_args_at(
        segment,
        started,
        stream_started_at_secs,
        observed_at_secs,
    ))
}

/// 話者ラベルを正規化する。
///
/// - 前後の空白をトリム
/// - `None` または空文字列は `"不明"` にフォールバック
/// - それ以外は受け取った値をそのまま採用（`transcription.rs` 側で
///   既に `"自分"` / `"相手側"` が付与されているため）
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
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        }
    }

    #[test]
    fn speaker_is_trimmed_and_none_falls_back_to_unknown_label() {
        // None → "不明" にフォールバック（Markdown 仕様で話者欄を埋めるため）
        let seg_none = TranscriptionSegment {
            text: "x".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: None,
            is_error: None,
        };
        let (speaker, _, _) = segment_to_append_args(&seg_none, 1000, 1000);
        assert_eq!(speaker, "不明");

        // 前後の空白はトリムされる
        let seg_ws = TranscriptionSegment {
            text: "x".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("  自分  ".to_string()),
            is_error: None,
        };
        let (speaker, _, _) = segment_to_append_args(&seg_ws, 1000, 1000);
        assert_eq!(speaker, "自分");
    }

    #[test]
    fn offset_saturates_to_zero_when_segment_time_precedes_session_start() {
        // ストリーム開始時刻 < セッション開始時刻（clock 調整・先行バッファ等で起こり得る）
        // このとき負のオフセットにせず 0 に飽和させる（堅牢性のため）。
        let segment = TranscriptionSegment {
            text: "early".to_string(),
            start_ms: 0,
            end_ms: 100,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let (_, offset, _) = segment_to_append_args(&segment, 1000, 990);
        assert_eq!(offset, 0, "clock 逆転時は offset は 0 に飽和する");

        // 負の start_ms も安全側に倒す
        let neg_segment = TranscriptionSegment {
            text: "neg".to_string(),
            start_ms: -5_000,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let (_, offset, _) = segment_to_append_args(&neg_segment, 1000, 1000);
        assert_eq!(offset, 0, "負の start_ms も 0 に飽和する");
    }

    #[test]
    fn build_append_args_saturates_offset_when_stream_precedes_session() {
        // 境界: stream_started_at_secs < session_started_at_secs のケース。
        // このヘルパーは segment_to_append_args の saturating 挙動をそのまま
        // 引き継ぐべきで、独立した clamp 実装を挟まない。
        let segment = TranscriptionSegment {
            text: "early".into(),
            start_ms: 0,
            end_ms: 100,
            source: None,
            speaker: Some("相手側".into()),
            is_error: None,
        };
        let result = build_append_args_for_emission(&segment, Some(1000), 990)
            .expect("Some 系統の結果が返る");
        assert_eq!(
            result.1, 0,
            "clock 逆転時でも負の offset にはせず 0 に飽和する"
        );
    }

    #[test]
    fn build_append_args_returns_some_with_same_values_as_segment_to_append_args() {
        // Some(started) が渡されたときは segment_to_append_args と同じ結果を
        // Some で包んで返す（二重実装になっていないことの回帰防止）。
        let segment = sample_segment();
        let expected = segment_to_append_args(&segment, 1000, 1040);
        let actual = build_append_args_for_emission(&segment, Some(1000), 1040)
            .expect("session 開始済みなら Some を返す");
        assert_eq!(actual, expected);
        // 具体値でも確認（happy path の値）
        assert_eq!(actual.0, "自分");
        assert_eq!(actual.1, 42);
        assert_eq!(actual.2, "こんにちは");
    }

    #[test]
    fn zero_start_segment_uses_observed_time_when_available() {
        // OpenAI / ElevenLabs Realtime など、確定イベントに開始時刻が無いエンジンは
        // start_ms = 0, end_ms = 0 で流れてくる。stream 開始時刻に固定すると
        // Markdown の全行が同じ時刻になるため、観測時刻へフォールバックする。
        let segment = TranscriptionSegment {
            text: "realtime".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("相手側".to_string()),
            is_error: None,
        };

        let (_, offset, text) = segment_to_append_args_at(&segment, 1_000, 1_000, Some(1_075));

        assert_eq!(offset, 75);
        assert_eq!(text, "realtime");
    }

    #[test]
    fn zero_start_with_positive_end_keeps_engine_timestamp_over_observed_time() {
        // ローカル/クラウド Whisper の先頭セグメントは start_ms = 0 でも end_ms を持つ。
        // これは「時刻なし」ではなく、ストリーム先頭の実セグメントとして扱う。
        let segment = TranscriptionSegment {
            text: "first segment".to_string(),
            start_ms: 0,
            end_ms: 1_200,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };

        let (_, offset, _) = segment_to_append_args_at(&segment, 1_000, 1_040, Some(9_999));

        assert_eq!(offset, 40);
    }

    #[test]
    fn positive_start_segment_keeps_engine_timestamp_over_observed_time() {
        let segment = sample_segment();

        let (_, offset, _) = segment_to_append_args_at(&segment, 1_000, 1_040, Some(9_999));

        assert_eq!(offset, 42);
    }

    #[test]
    fn build_append_args_returns_none_when_session_not_started() {
        // セッション未開始時 (session_started_at_secs == None) は append をスキップしたい。
        // live loop 側が「None なら呼ばない」と条件分岐できるよう、このヘルパーが None を返す。
        let segment = sample_segment();
        let result = build_append_args_for_emission(&segment, None, 1000);
        assert!(result.is_none(), "session 未開始時は None を返す");
    }

    #[test]
    fn build_append_args_returns_none_for_error_segments() {
        // Realtime provider error は会議中 UI には出すが、議事録本文へ通常発話として保存しない。
        let mut segment = sample_segment();
        segment.text = "[OpenAI Realtime エラー: connection closed]".to_string();
        segment.is_error = Some(true);

        let result = build_append_args_for_emission(&segment, Some(1000), 1000);

        assert!(result.is_none(), "error segment は append 対象外にする");
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

    #[test]
    fn text_is_trimmed_before_append_without_collapsing_inner_whitespace() {
        let mut segment = sample_segment();
        segment.text = " \n  hello   world \t ".to_string();

        let (_, _, text) = segment_to_append_args(&segment, 1000, 1040);

        assert_eq!(text, "hello   world");
    }

    #[test]
    fn normalize_speaker_returns_unknown_for_none() {
        assert_eq!(normalize_speaker(None), "不明");
    }

    #[test]
    fn normalize_speaker_returns_unknown_for_empty_string() {
        assert_eq!(normalize_speaker(Some("")), "不明");
    }

    #[test]
    fn normalize_speaker_returns_unknown_for_whitespace_only() {
        assert_eq!(normalize_speaker(Some("   ")), "不明");
        assert_eq!(normalize_speaker(Some("\t\n  ")), "不明");
    }

    #[test]
    fn normalize_speaker_passes_through_normal_label() {
        assert_eq!(normalize_speaker(Some("Alice")), "Alice");
        assert_eq!(normalize_speaker(Some("自分")), "自分");
        assert_eq!(normalize_speaker(Some("相手側")), "相手側");
    }

    #[test]
    fn normalize_speaker_trims_surrounding_whitespace_only() {
        // 前後の空白だけを落とし、内部の空白は保持する契約
        assert_eq!(normalize_speaker(Some("  Alice  ")), "Alice");
        assert_eq!(normalize_speaker(Some(" Alice Bob ")), "Alice Bob");
    }

    #[test]
    fn build_append_args_for_emission_at_returns_none_for_error_segment_even_with_observed_time() {
        // build_append_args_for_emission (observed=None 固定) 経由の既存 test とは異なり、
        // _at を直接呼んで observed=Some(1075) を渡しても is_error の早期リターンが有効である現契約を固定。
        let mut segment = sample_segment();
        segment.is_error = Some(true);
        let result = build_append_args_for_emission_at(&segment, Some(1_000), 1_000, Some(1_075));
        assert!(
            result.is_none(),
            "is_error の早期リターンは observed_at_secs があっても有効"
        );
    }

    #[test]
    fn build_append_args_for_emission_at_returns_none_when_session_not_started_with_observed_time()
    {
        // build_append_args_for_emission (observed=None 固定) 経由の既存 test とは異なり、
        // _at を直接呼んで observed=Some(1075) を渡しても session 未開始の早期リターンが優先される現契約を固定。
        let segment = sample_segment(); // is_error = None
        let result = build_append_args_for_emission_at(&segment, None, 1_000, Some(1_075));
        assert!(
            result.is_none(),
            "session_started_at_secs == None なら observed があっても None"
        );
    }

    #[test]
    fn build_append_args_for_emission_at_uses_observed_time_for_zero_start_segment() {
        // Realtime 系の zero_start segment (start_ms=0, end_ms=0) は observed_at_secs に倒れる。
        // emission helper 経由でも segment_to_append_args_at の zero_start ロジックが正しく接続されていることを保証。
        let segment = TranscriptionSegment {
            text: "realtime".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("相手側".to_string()),
            is_error: None,
        };
        let result = build_append_args_for_emission_at(&segment, Some(1_000), 1_000, Some(1_075))
            .expect("observed があれば Some を返す");
        assert_eq!(result.0, "相手側");
        assert_eq!(
            result.1, 75,
            "zero_start segment は observed_at_secs - session_started_at_secs を使う"
        );
        assert_eq!(result.2, "realtime");
    }

    #[test]
    fn build_append_args_for_emission_at_keeps_engine_timestamp_when_present_ignoring_observed_time(
    ) {
        // engine timestamp ありなら observed は無視される。
        // emission helper 経由でも「engine timestamp 優先」の現契約が維持されていることを保証。
        // observed=9_999 という極端値を渡しても 42 になることで「engine timestamp が確実に勝つ」を示す。
        let segment = sample_segment(); // start_ms=2000, end_ms=3500, speaker="自分", text="こんにちは"
        let result = build_append_args_for_emission_at(&segment, Some(1_000), 1_040, Some(9_999))
            .expect("Some を返す");
        assert_eq!(result.0, "自分");
        assert_eq!(
            result.1, 42,
            "engine timestamp あり時は observed を無視し engine timestamp が勝つ"
        );
        assert_eq!(result.2, "こんにちは");
    }

    #[test]
    fn build_append_args_for_emission_at_short_circuits_on_error_before_checking_session_started() {
        // is_error=true かつ session_started_at_secs=None の二重違反。
        // どちらの早期リターンが先に来ても結果は None である現契約を固定。
        let mut segment = sample_segment();
        segment.is_error = Some(true);
        let result = build_append_args_for_emission_at(&segment, None, 1_000, Some(1_075));
        assert!(
            result.is_none(),
            "is_error と session 未開始の二重違反でも None (どちらが先でも結果同じ)"
        );
    }
}
