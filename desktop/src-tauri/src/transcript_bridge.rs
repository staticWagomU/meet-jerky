//! ライブ文字起こしの `TranscriptionSegment` を
//! `Session::append_segment` に渡すための純粋な変換ブリッジ。

use crate::transcription_types::TranscriptionSegment;

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

    #[test]
    fn normalize_speaker_trims_unicode_full_width_space_u3000() {
        // U+3000 は str::trim の対象 (Unicode White_Space プロパティ準拠の現契約を固定)
        assert_eq!(normalize_speaker(Some("\u{3000}相手側\u{3000}")), "相手側");
        // U+3000 + ASCII spaces 混在も trim される
        assert_eq!(
            normalize_speaker(Some("\u{3000}  Alice  \u{3000}")),
            "Alice"
        );
    }

    #[test]
    fn normalize_speaker_returns_unknown_for_only_unicode_full_width_spaces() {
        // U+3000 のみ → trim 後 empty → "不明" fallback
        assert_eq!(normalize_speaker(Some("\u{3000}\u{3000}")), "不明");
        // U+3000 + ASCII whitespace 混在のみ → trim 後 empty → "不明" fallback
        assert_eq!(normalize_speaker(Some("\u{3000}\t\n\u{3000}")), "不明");
    }

    #[test]
    fn normalize_speaker_passes_through_nul_byte_label() {
        // NUL byte は char::is_whitespace で false → trim 対象外、passthrough の現契約を固定
        assert_eq!(normalize_speaker(Some("\0")), "\0");
        // NUL + 通常文字: 前置 NUL も trim されない
        assert_eq!(normalize_speaker(Some("\0Alice")), "\0Alice");
    }

    #[test]
    fn normalize_speaker_passes_through_control_character_label() {
        // SOH (U+0001) は ASCII control だが whitespace ではない → passthrough の現契約を固定
        assert_eq!(normalize_speaker(Some("\x01alpha")), "\x01alpha");
        // DEL (U+007F) も control だが whitespace ではない → passthrough
        assert_eq!(normalize_speaker(Some("\u{007F}beta")), "\u{007F}beta");
    }

    #[test]
    fn normalize_speaker_passes_through_zero_width_space_label() {
        // ZWSP (U+200B) は char::is_whitespace で false → trim 対象外の現契約を固定
        assert_eq!(normalize_speaker(Some("\u{200B}name")), "\u{200B}name");
        // ZWJ (U+200D) も passthrough
        assert_eq!(normalize_speaker(Some("\u{200D}name")), "\u{200D}name");
        // ZWSP のみでも trim されないので passthrough (fallback にはならない)
        assert_eq!(
            normalize_speaker(Some("\u{200B}\u{200B}")),
            "\u{200B}\u{200B}"
        );
    }

    #[test]
    fn segment_to_append_args_ignores_source_field_completely() {
        // T1: source field は normalize_speaker / offset 計算 / text trim のどれでも参照されない契約を固定。
        // 将来 source を判定に組み込む誤改修 (例: Microphone と SystemAudio で speaker 自動上書き) への検知装置。
        let make_seg =
            |source: Option<crate::transcription::TranscriptionSource>| TranscriptionSegment {
                text: "  hello  ".to_string(),
                start_ms: 2_000,
                end_ms: 3_500,
                source,
                speaker: Some("自分".to_string()),
                is_error: None,
            };

        let baseline = segment_to_append_args(&make_seg(None), 1_000, 1_040);
        let with_mic = segment_to_append_args(
            &make_seg(Some(crate::transcription::TranscriptionSource::Microphone)),
            1_000,
            1_040,
        );
        let with_sys = segment_to_append_args(
            &make_seg(Some(crate::transcription::TranscriptionSource::SystemAudio)),
            1_000,
            1_040,
        );

        assert_eq!(
            baseline, with_mic,
            "source=None と Microphone で結果差分なし契約"
        );
        assert_eq!(
            baseline, with_sys,
            "source=None と SystemAudio で結果差分なし契約 = source field は無視される"
        );
        assert_eq!(
            with_mic, with_sys,
            "Microphone と SystemAudio でも差分なし = source 全 variant 無視契約"
        );
        assert_eq!(baseline.0, "自分");
        assert_eq!(baseline.1, 42);
        assert_eq!(baseline.2, "hello");
    }

    #[test]
    fn build_append_args_for_emission_returns_some_when_is_error_is_some_false() {
        // T2: is_error の Option<bool> 3 状態のうち Some(false) 経路を固定。
        // unwrap_or(false) で false → early return せず Some を返す現契約。
        // None と Some(true) は既存 test 済、Some(false) のみ空白だった。
        // unwrap_or(true) 等への誤改修への検知装置 = Option 3 状態の semantics 反転検知。
        let mut segment = sample_segment();
        segment.is_error = Some(false);

        let result = build_append_args_for_emission(&segment, Some(1_000), 1_040);

        assert!(
            result.is_some(),
            "is_error=Some(false) は早期 return せず Some を返す契約 = unwrap_or(false) の false 分岐"
        );
        let expected = segment_to_append_args(&segment, 1_000, 1_040);
        assert_eq!(
            result.unwrap(),
            expected,
            "is_error=Some(false) なら is_error=None と同じ結果 (None と Some(false) は等価)"
        );
    }

    #[test]
    fn build_append_args_for_emission_returns_some_when_session_started_at_is_some_zero() {
        // T3: session_started_at_secs=Some(0) boundary で ? 演算子は Some(0) を通す現契約を固定。
        // ? を unwrap_or(default) や 0 == None 扱いへの誤改修 (Some(0) を None として扱う) への検知装置。
        // session_started_at_secs=0 自体は session 開始時刻 = epoch を意味し、有効な session 状態。
        let segment = sample_segment(); // start_ms=2000

        let result = build_append_args_for_emission(&segment, Some(0), 0);

        assert!(
            result.is_some(),
            "Some(0) は ? を通る契約 = 0 値を None と混同しない"
        );
        let (speaker, offset, text) = result.unwrap();
        assert_eq!(speaker, "自分");
        // session_started_at=0, stream_started_at=0, start_ms=2000 → segment_abs=2s, offset = 2 - 0 = 2
        assert_eq!(
            offset, 2,
            "Some(0) base で offset 計算が正常動作する契約 (saturating_sub 0 base)"
        );
        assert_eq!(text, "こんにちは");
    }

    #[test]
    fn segment_to_append_args_at_has_engine_timestamp_or_boundary_complete_decomposition() {
        // T4: line 36 `segment.start_ms > 0 || segment.end_ms > 0` の OR 短絡評価の 5 状態完全分解。
        // (0, 0): false → observed fallback 経路
        // (1000, 0): true → engine timestamp 経路 (start_ms 単独 true)
        // (0, 1000): true → engine timestamp 経路 (end_ms 単独 true, start_ms.max(0)=0 → offset=0)
        // (-1000, 0): false → observed fallback 経路 (start_ms 負値は > 0 でない)
        // (-1000, 1000): true → engine timestamp 経路 (end_ms 単独 true, start_ms.max(0)=0 → offset=0)
        // || を && に変更する、片側だけチェックする誤改修を完全分解で検知。
        let cases: Vec<(i64, i64, u64, &str)> = vec![
            (
                0,
                0,
                75,
                "(0,0) → has_engine_timestamp=false → observed fallback offset=75",
            ),
            (
                1_000,
                0,
                1,
                "(1000ms,0) → has_engine_timestamp=true → engine: stream+1s → offset=1",
            ),
            (
                0,
                1_000,
                0,
                "(0,1000ms) → has_engine_timestamp=true → start_ms.max(0)=0 → offset=0",
            ),
            (
                -1_000,
                0,
                75,
                "(-1000ms,0) → has_engine_timestamp=false → observed fallback offset=75",
            ),
            (
                -1_000,
                1_000,
                0,
                "(-1000ms,1000ms) → has_engine_timestamp=true → start_ms.max(0)=0 → offset=0",
            ),
        ];
        for (start_ms, end_ms, expected_offset, label) in cases {
            let segment = TranscriptionSegment {
                text: "test".to_string(),
                start_ms,
                end_ms,
                source: None,
                speaker: Some("自分".to_string()),
                is_error: None,
            };
            // session_started_at=1000, stream_started_at=1000 (同値 → engine 経路で stream + offset_secs)
            // observed_at_secs=Some(1075) → fallback 経路で 75 offset
            let (_, offset, _) = segment_to_append_args_at(&segment, 1_000, 1_000, Some(1_075));
            assert_eq!(
                offset, expected_offset,
                "OR 境界完全分解: {label} で expected_offset={expected_offset}"
            );
        }
    }

    #[test]
    fn segment_to_append_args_saturates_to_u64_max_for_extreme_start_ms() {
        // T5: start_ms = i64::MAX 経由の (i64::MAX.max(0) / 1000) as u64 + saturating_add(u64::MAX) で飽和契約を固定。
        // i64::MAX / 1000 = 9_223_372_036_854_775 → as u64 → saturating_add(u64::MAX) → u64::MAX に張り付く。
        // session_started_at=0 なので final offset = u64::MAX - 0 = u64::MAX。
        // panic 化や別キャスト方式への誤改修検知。
        let segment = TranscriptionSegment {
            text: "extreme".to_string(),
            start_ms: i64::MAX,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };

        let (_, offset, _) = segment_to_append_args(&segment, 0, u64::MAX);

        assert_eq!(
            offset,
            u64::MAX,
            "i64::MAX start_ms → saturating_add(u64::MAX) → u64::MAX に飽和 + offset = u64::MAX - 0 = u64::MAX"
        );
    }

    #[test]
    fn segment_to_append_args_falls_back_to_stream_started_when_zero_start_and_observed_none() {
        // zero_start segment + observed=None で `unwrap_or(stream_started_at_secs)` の None 分岐が動く契約。
        // observed=None 経路は segment_to_append_args の内部固定。
        let segment = TranscriptionSegment {
            text: "test".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let (_, offset, _) = segment_to_append_args(&segment, 1_000, 1_040);
        assert_eq!(
            offset,
            40,
            "zero_start + observed=None → stream_started_at_secs(1040) - session_started_at_secs(1000) = 40"
        );
    }

    #[test]
    fn segment_to_append_args_trims_unicode_full_width_space_in_text() {
        // U+3000 は str::trim 対象 (Unicode White_Space プロパティ準拠)。
        // speaker 側で確認済の現契約を text 側でも固定。
        let mut segment = sample_segment();
        segment.text = "\u{3000}\u{3000}hello\u{3000}\u{3000}".to_string();

        let (_, _, text) = segment_to_append_args(&segment, 1_000, 1_040);

        assert_eq!(
            text, "hello",
            "前後の U+3000 が trim される。内部 \"hello\" はそのまま"
        );
    }

    #[test]
    fn segment_to_append_args_returns_empty_text_when_text_is_only_whitespace() {
        // text 全 whitespace → trim 後 "" を返す契約。
        // empty 時の fallback (例: "(空)" 等) を後付けする誤改修への検知。
        // speaker 側 (`speaker_is_trimmed_and_none_falls_back_to_unknown_label` の None fallback) と非対称な契約 = text には "不明" 相当のフォールバックは存在しない。
        let segment = TranscriptionSegment {
            text: "\u{3000}\t\n  \u{3000}".to_string(),
            start_ms: 2_000,
            end_ms: 3_500,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let (_, _, text) = segment_to_append_args(&segment, 1_000, 1_040);
        assert_eq!(
            text, "",
            "text が全 whitespace のとき trim 後 \"\" を返す契約 = empty 時のフォールバックなし"
        );
    }

    #[test]
    fn build_append_args_for_emission_at_falls_back_to_stream_started_when_zero_start_and_observed_none(
    ) {
        // emission helper 経由でも zero_start + observed=None の場合に stream_started_at_secs フォールバックが効く現契約。
        // Loop 1 T1 (segment_to_append_args 低層) と対称な emission helper 高層の test。
        // 既存 `build_append_args_for_emission_at_uses_observed_time_for_zero_start_segment` は
        // observed=Some(1075) のみ、本 test は observed=None (None 分岐) を固定。
        let segment = TranscriptionSegment {
            text: "test".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let result = build_append_args_for_emission_at(&segment, Some(1_000), 1_040, None)
            .expect("session 開始済みかつ is_error=None なら Some を返す");
        assert_eq!(result.0, "自分", "speaker は正規化された 'self'");
        assert_eq!(
            result.1, 40,
            "zero_start + observed=None → stream_started_at_secs(1040) - session_started_at_secs(1000) = 40"
        );
        assert_eq!(result.2, "test", "text はそのまま返る");
    }

    #[test]
    fn build_append_args_for_emission_at_saturates_offset_when_session_after_observed_with_zero_start(
    ) {
        // zero_start segment (has_engine_timestamp=false) で observed_at_secs < session_started_at_secs のとき、
        // saturating_sub によって offset が 0 に飽和する emission helper 経由の現契約。
        // Loop 1 で範囲外だった zero_start + clock 逆転の組み合わせを emission helper 経由で固定。
        // 既存 `build_append_args_saturates_offset_when_stream_precedes_session` は
        // (start_ms=0, end_ms=100) で has_engine_timestamp=true 経路、本 test は end_ms=0 の zero_start 経路。
        let segment = TranscriptionSegment {
            text: "early".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("相手側".to_string()),
            is_error: None,
        };
        let result = build_append_args_for_emission_at(&segment, Some(1_000), 990, Some(995))
            .expect("session 開始済みかつ is_error=None なら Some を返す");
        assert_eq!(
            result.1, 0,
            "zero_start segment で observed(995) < session(1000) → saturating_sub で offset=0 に飽和"
        );
    }

    #[test]
    fn build_append_args_for_emission_at_returns_some_for_zero_start_with_is_error_some_false() {
        // is_error=Some(false) かつ zero_start segment かつ observed=Some の 3 軸合流。
        // Some(false) は unwrap_or(false) で false → 早期 return せず Some を返し、
        // zero_start 経路で observed_at_secs を使う現契約を固定。
        // 既存 `build_append_args_for_emission_returns_some_when_is_error_is_some_false` は
        // sample_segment (start_ms=2000, engine 経路) のみ、zero_start 経路は未保護。
        let segment = TranscriptionSegment {
            text: "realtime".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: Some(false),
        };
        let result = build_append_args_for_emission_at(&segment, Some(1_000), 1_000, Some(1_075))
            .expect("is_error=Some(false) は早期 return せず Some を返す契約");
        assert_eq!(
            result.0, "自分",
            "is_error=Some(false) + zero_start でも speaker は正規化されて返る"
        );
        assert_eq!(
            result.1, 75,
            "is_error=Some(false) + zero_start → observed(1075) - session(1000) = 75"
        );
        assert_eq!(result.2, "realtime", "text はそのまま返る");
    }

    #[test]
    fn build_append_args_for_emission_falls_back_to_stream_started_when_zero_start_segment() {
        // wrapper 経由でも zero_start + 内部固定 observed=None で stream_started_at_secs フォールバックが効く現契約。
        // Loop 1 T1 (segment_to_append_args 低層) + Loop 2 T1 (build_append_args_for_emission_at 中層) と対称的に wrapper 高層で同境界を 3 層保護。
        let segment = TranscriptionSegment {
            text: "test".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let result = build_append_args_for_emission(&segment, Some(1_000), 1_040)
            .expect("session 開始済みかつ is_error=None なら Some を返す");
        assert!(result.1 == 40, "wrapper 経由で zero_start + observed=None → stream_started_at_secs(1040) - session(1000) = 40");
    }

    #[test]
    fn build_append_args_for_emission_at_handles_extreme_observed_at_secs_max_with_zero_start() {
        // zero_start + observed=Some(u64::MAX) + session=Some(0) → segment_abs=u64::MAX → offset=u64::MAX (saturating_sub の no-op 範囲)。
        // panic 化や別キャスト方式への誤改修検知。Loop 1 T5 (engine path 極端値) と対称な observed path 極端値。
        let segment = TranscriptionSegment {
            text: "extreme".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("自分".to_string()),
            is_error: None,
        };
        let result = build_append_args_for_emission_at(&segment, Some(0), 0, Some(u64::MAX))
            .expect("session=Some(0) かつ is_error=None なら Some を返す");
        assert_eq!(
            result.1,
            u64::MAX,
            "zero_start + observed=Some(u64::MAX) + session=Some(0) → segment_abs=u64::MAX → offset=u64::MAX (saturating_sub の no-op 範囲)"
        );
    }

    #[test]
    fn build_append_args_for_emission_at_saturates_to_zero_when_session_at_max_with_zero_start() {
        // session=Some(u64::MAX) + zero_start + stream=0 + observed=None → segment_abs=0 → saturating_sub(0, u64::MAX)=0 (extreme clock 逆転)。
        // Loop 2 T2 (通常範囲の clock 逆転) と対称な極端値版。?演算子は Some(u64::MAX) も通る (= 0 と混同しない) 契約も同時に固定。
        let segment = TranscriptionSegment {
            text: "boundary".to_string(),
            start_ms: 0,
            end_ms: 0,
            source: None,
            speaker: Some("相手側".to_string()),
            is_error: None,
        };
        let result =
            build_append_args_for_emission_at(&segment, Some(u64::MAX), 0, None).expect(
                "session=Some(u64::MAX) かつ is_error=None なら Some を返す (? 演算子は Some(u64::MAX) を通す)",
            );
        assert_eq!(
            result.1,
            0,
            "session=Some(u64::MAX) + zero_start + stream=0 + observed=None → segment_abs=0 → saturating_sub(0, u64::MAX)=0"
        );
    }
}
