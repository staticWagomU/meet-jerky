//! 話者ラベル (speaker label) 正規化の純粋関数。
//!
//! `transcription.rs` 等で `"自分"` / `"相手側"` 等の文字列ラベルが
//! `TranscriptionSegment::speaker` (`Option<String>`) に格納される。
//! この純粋関数で前後の whitespace を trim + 空文字列 / `None` フォールバックを
//! `"不明"` に統一する。`transcript_bridge::segment_to_append_args*` から呼ばれ、
//! `Session::append_segment` の話者欄 (Markdown 仕様) に渡される。

/// 話者ラベルを正規化する。
///
/// - 前後の空白をトリム
/// - `None` または空文字列は `"不明"` にフォールバック
/// - それ以外は受け取った値をそのまま採用（`transcription.rs` 側で
///   既に `"自分"` / `"相手側"` が付与されているため）
pub fn normalize_speaker(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "不明".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
