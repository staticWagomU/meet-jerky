//! ElevenLabs / OpenAI realtime stream の WS タスクへ送る音声コマンド。
//!
//! `elevenlabs_realtime.rs` と `openai_realtime.rs` で重複していた private enum を
//! 共通化したもの。両 file とも `Samples(Vec<f32>)` でサンプルを送り、`Finalize` で
//! 入力終了を伝えて WS をクローズする pattern を持つ。

#[derive(Debug)]
pub(crate) enum AudioCommand {
    Samples(Vec<f32>),
    /// 入力終了を示す。WS タスクは flush してから WS をクローズする。
    Finalize,
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::AudioCommand;

    pub fn assert_samples_variant_debug_format_contains_variant_name_and_payload_floats() {
        let cmd = AudioCommand::Samples(vec![1.0_f32, -0.5, 0.0]);
        let formatted = format!("{cmd:?}");
        assert!(formatted.contains("Samples"), "variant 名: {formatted}");
        assert!(formatted.contains("1.0"), "first sample: {formatted}");
        assert!(formatted.contains("-0.5"), "second sample: {formatted}");
        assert!(formatted.contains("0.0"), "third sample: {formatted}");
    }

    pub fn assert_finalize_variant_debug_format_is_exact_variant_name() {
        let cmd = AudioCommand::Finalize;
        let formatted = format!("{cmd:?}");
        assert_eq!(formatted, "Finalize", "完全一致: {formatted}");
        assert!(formatted.contains("Finalize"));
    }

    pub fn assert_samples_with_empty_vec_debug_format_contains_variant_name_and_empty_brackets() {
        let cmd = AudioCommand::Samples(vec![]);
        let formatted = format!("{cmd:?}");
        assert!(formatted.contains("Samples"), "variant 名: {formatted}");
        assert!(
            formatted.contains("[]"),
            "空 Vec の Debug 表示: {formatted}"
        );
        assert!(
            formatted.contains("Samples([])"),
            "tuple variant 形式: {formatted}"
        );
    }
}
