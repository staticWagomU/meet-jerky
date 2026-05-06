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

    /// Engine の Debug 出力が型名 + 指定 field 名 + 空文字列 (`""`) を含むことを検証する.
    ///
    /// `ElevenLabsRealtimeEngine::default()` / `OpenAIRealtimeEngine::default()` の test で共有.
    pub fn assert_engine_default_debug_format(
        formatted: &str,
        expected_type_name: &str,
        expected_field_name: &str,
    ) {
        assert!(formatted.contains(expected_type_name), "型名: {formatted}");
        assert!(
            formatted.contains(expected_field_name),
            "field 名: {formatted}"
        );
        assert!(
            formatted.contains("\"\""),
            "空 String を Debug 出力: {formatted}"
        );
    }

    /// Engine の Debug 出力が型名 + 指定 field 名 + 指定 model 値 (引用符込み) を含むことを検証する.
    ///
    /// `Engine::new(&str)` / `Engine::new(String)` の test で共有.
    pub fn assert_engine_with_model_value_debug_format(
        formatted: &str,
        expected_type_name: &str,
        expected_field_name: &str,
        expected_model_value: &str,
    ) {
        assert!(formatted.contains(expected_type_name));
        assert!(formatted.contains(expected_field_name));
        assert!(formatted.contains(&format!("\"{expected_model_value}\"")));
    }
}
