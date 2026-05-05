//! Apple SpeechAnalyzer (macOS 26+) を `TranscriptionEngine` trait の実装として
//! ラップするモジュール。
//!
//! Swift 側の `SpeechAnalyzerBridge.swift` が提供する C ABI を呼び出す。
//! Linux / Windows ではコンパイルだけ通すために、`start_stream` がエラーを
//! 返すスタブ実装を提供する。

use std::sync::Arc;

use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};

/// Apple SpeechAnalyzer エンジン (macOS 26+ 専用)。
///
/// 非 macOS プラットフォームでは `start_stream` が常にエラーを返す。
#[derive(Debug)]
pub struct AppleSpeechEngine;

impl AppleSpeechEngine {
    pub fn new() -> Result<Self, String> {
        if !cfg!(target_os = "macos") {
            return Err(
                "Apple SpeechAnalyzer は macOS でのみ利用できます。Whisper など別エンジンを選択してください。"
                    .to_string(),
            );
        }
        Ok(Self)
    }
}

impl TranscriptionEngine for AppleSpeechEngine {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String> {
        #[cfg(target_os = "macos")]
        {
            let stream = crate::apple_speech_macos::AppleSpeechStream::new(config)?;
            Ok(Box::new(stream))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = config;
            Err(
                "Apple SpeechAnalyzer は macOS でのみ利用できます。Whisper など別エンジンを選択してください。"
                    .to_string(),
            )
        }
    }
}

/// `language` 設定値を BCP-47 ロケール ID に変換する。
///
/// 設定 UI が "auto" / "ja" / "en" の 3 値を提供するが、SpeechAnalyzer は
/// 具体的なロケールを要求するので auto 時は OS の優先言語 (簡易実装は ja-JP)
/// にフォールバックする。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn language_to_locale(language: &str) -> &'static str {
    match language {
        "ja" => "ja-JP",
        "en" => "en-US",
        // "auto" や未知の値はひとまず ja-JP。
        // (将来的には Locale.current から推測する余地あり)
        _ => "ja-JP",
    }
}

pub(crate) fn normalize_segment_text(text: &str) -> String {
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_to_locale_maps_supported_languages() {
        assert_eq!(language_to_locale("ja"), "ja-JP");
        assert_eq!(language_to_locale("en"), "en-US");
    }

    #[test]
    fn language_to_locale_falls_back_to_japanese_for_auto_or_unknown() {
        // 設定 UI が "auto" を出すので、必ずロケールが返ること
        assert_eq!(language_to_locale("auto"), "ja-JP");
        assert_eq!(language_to_locale(""), "ja-JP");
        assert_eq!(language_to_locale("xx"), "ja-JP");
    }

    #[test]
    fn normalize_segment_text_trims_edges_only() {
        assert_eq!(
            normalize_segment_text(" \tHello,  world.\n"),
            "Hello,  world."
        );
        assert_eq!(
            normalize_segment_text("句読点。  内部  空白"),
            "句読点。  内部  空白"
        );
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn engine_errors_on_non_macos() {
        // 非 macOS では new() で即エラー。Linux CI / 開発環境で
        // ビルドが通ることを保証する一方、誤ってこのエンジンが
        // 選ばれた場合に分かりやすいエラーを返す。
        let err = AppleSpeechEngine::new().unwrap_err();
        assert!(err.contains("macOS"));
    }

    #[test]
    fn normalize_segment_text_returns_empty_for_empty_input() {
        assert_eq!(super::normalize_segment_text(""), "");
    }

    #[test]
    fn normalize_segment_text_returns_empty_for_whitespace_only_inputs() {
        assert_eq!(super::normalize_segment_text("   "), "");
        assert_eq!(super::normalize_segment_text("\t\n  "), "");
        assert_eq!(super::normalize_segment_text(" \t \n "), "");
    }

    #[test]
    fn normalize_segment_text_preserves_internal_whitespace_only_trims_edges() {
        assert_eq!(
            super::normalize_segment_text("  hello world  "),
            "hello world"
        );
        assert_eq!(
            super::normalize_segment_text("  hello   world  "),
            "hello   world"
        );
        assert_eq!(
            super::normalize_segment_text("  日本語  テキスト  "),
            "日本語  テキスト"
        );
    }

    #[test]
    fn language_to_locale_is_case_sensitive_and_falls_back_for_uppercase() {
        assert_eq!(super::language_to_locale("JA"), "ja-JP");
        assert_eq!(super::language_to_locale("EN"), "ja-JP");
        assert_eq!(super::language_to_locale("Ja"), "ja-JP");
        assert_eq!(super::language_to_locale("jA"), "ja-JP");
    }

    #[test]
    fn language_to_locale_falls_back_for_empty_and_whitespace_inputs() {
        assert_eq!(super::language_to_locale(""), "ja-JP");
        assert_eq!(super::language_to_locale(" "), "ja-JP");
        assert_eq!(super::language_to_locale("ja "), "ja-JP");
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn apple_speech_engine_new_returns_exact_japanese_error_message_on_non_macos_build() {
        // 既存 engine_errors_on_non_macos は contains 判定のみで、文言が "macOS" を
        // 含む別文字列に変えられても検知できない。完全一致 assert で UI 表示文言の
        // 体験保護を CI 固定する。Whisper 案内文の維持を保証する装置。
        let err = AppleSpeechEngine::new().unwrap_err();
        assert_eq!(
            err,
            "Apple SpeechAnalyzer は macOS でのみ利用できます。Whisper など別エンジンを選択してください。"
        );
    }

    #[test]
    fn language_to_locale_returns_values_always_in_bcp47_pattern_for_supported_and_fallback_inputs()
    {
        // BCP-47 形式 (xx-XX = 小文字-大文字) を全 input で保証する。既存 test は
        // 絶対値を固定するが format 規則は未明示のため、将来 variant 追加時の format
        // 一貫性を CI 固定する。「ISO 639-1 単独 ("ja") への変更」「format 変更」の
        // 誤改修を遮断する装置。
        for input in ["ja", "en", "auto", "", "xx", "Ja", "JA", "fr"] {
            let locale = language_to_locale(input);
            let parts: Vec<&str> = locale.split('-').collect();
            assert_eq!(
                parts.len(),
                2,
                "BCP-47 ハイフン区切りが 2 部分でない (input={input}, locale={locale})"
            );
            let (lang, region) = (parts[0], parts[1]);
            assert!(
                !lang.is_empty(),
                "ハイフン左側 (language) が空 (input={input}, locale={locale})"
            );
            assert!(
                !region.is_empty(),
                "ハイフン右側 (region) が空 (input={input}, locale={locale})"
            );
            assert!(
                lang.chars().all(|c| c.is_ascii_lowercase()),
                "ハイフン左側に小文字以外 (input={input}, locale={locale})"
            );
            assert!(
                region.chars().all(|c| c.is_ascii_uppercase()),
                "ハイフン右側に大文字以外 (input={input}, locale={locale})"
            );
        }
    }

    #[test]
    fn apple_speech_engine_debug_output_uses_struct_name_without_internal_field_leakage() {
        // unit struct の Debug 出力は型名のみで構成される (#[derive(Debug)] 自動派生
        // による Rust 言語仕様) 現契約を CI 固定する。将来「internal state 追加で
        // Debug にフィールドが漏れる誤改修」を遮断する装置。enum 派生 (Loop 1) と
        // 相補的に struct 派生をカバーすることで Debug 軸補強パターンを 2 連続適用。
        let dbg_output = format!("{:?}", AppleSpeechEngine);
        assert!(
            dbg_output.contains("AppleSpeechEngine"),
            "Debug 出力に struct 名がない: {dbg_output}"
        );
        assert!(
            !dbg_output.contains('{'),
            "Debug 出力に内部フィールドの波括弧が含まれる (unit struct 契約違反): {dbg_output}"
        );
        assert!(
            !dbg_output.contains('}'),
            "Debug 出力に内部フィールドの波括弧が含まれる (unit struct 契約違反): {dbg_output}"
        );
    }
}
