//! Apple SpeechAnalyzer (macOS 26+) を `TranscriptionEngine` trait の実装として
//! ラップするモジュール。
//!
//! Swift 側の `SpeechAnalyzerBridge.swift` が提供する C ABI を呼び出す。
//! Linux / Windows ではコンパイルだけ通すために、`start_stream` がエラーを
//! 返すスタブ実装を提供する。

use std::sync::Arc;

use crate::transcription::{StreamConfig, TranscriptionEngine, TranscriptionStream};

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
            let stream = macos::AppleSpeechStream::new(config)?;
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

fn normalize_segment_text(text: &str) -> String {
    text.trim().to_string()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, CStr, CString};

    use serde::Deserialize;

    use super::{language_to_locale, normalize_segment_text};
    use crate::transcription::{
        StreamConfig, TranscriptionSegment, TranscriptionSource, TranscriptionStream,
    };

    #[repr(C)]
    pub struct SpeechBridge {
        _private: [u8; 0],
    }

    extern "C" {
        fn meet_jerky_speech_create(
            locale_id: *const c_char,
            sample_rate: f64,
        ) -> *mut SpeechBridge;
        fn meet_jerky_speech_feed(
            bridge: *mut SpeechBridge,
            samples: *const f32,
            len: usize,
        ) -> i32;
        fn meet_jerky_speech_drain_json(bridge: *mut SpeechBridge) -> *const c_char;
        fn meet_jerky_speech_finalize(bridge: *mut SpeechBridge) -> i32;
        fn meet_jerky_speech_destroy(bridge: *mut SpeechBridge);
        fn meet_jerky_speech_free_string(s: *const c_char);
    }

    #[derive(Deserialize)]
    struct RawSegment {
        text: String,
        #[serde(rename = "startMs")]
        start_ms: i64,
        #[serde(rename = "endMs")]
        end_ms: i64,
    }

    pub struct AppleSpeechStream {
        bridge: *mut SpeechBridge,
        speaker: Option<String>,
        source: Option<TranscriptionSource>,
        finalized: bool,
    }

    // SpeechBridge は内部で同期化してあるため、`Send` 安全。
    // `TranscriptionStream` trait が Send を要求するので明示する。
    unsafe impl Send for AppleSpeechStream {}

    impl AppleSpeechStream {
        pub fn new(config: StreamConfig) -> Result<Self, String> {
            let locale = language_to_locale(config.language.as_deref().unwrap_or("auto"));
            let c_locale = CString::new(locale)
                .map_err(|e| format!("ロケール文字列の変換に失敗しました: {e}"))?;

            // Safety: c_locale は呼び出し中ずっと生存する。
            let bridge =
                unsafe { meet_jerky_speech_create(c_locale.as_ptr(), config.sample_rate as f64) };

            if bridge.is_null() {
                return Err(
                    "SpeechAnalyzer の初期化に失敗しました (権限・OS バージョンを確認してください)"
                        .to_string(),
                );
            }

            Ok(Self {
                bridge,
                speaker: config.speaker,
                source: config.source,
                finalized: false,
            })
        }

        fn drain_inner(&mut self) -> Vec<TranscriptionSegment> {
            // Safety: bridge は new() 後 destroy 前のあいだ valid。
            let json_ptr = unsafe { meet_jerky_speech_drain_json(self.bridge) };
            if json_ptr.is_null() {
                return Vec::new();
            }

            // C 文字列を所有付き String にコピーしてから解放する。
            let json_owned = unsafe { CStr::from_ptr(json_ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { meet_jerky_speech_free_string(json_ptr) };

            let raw: Vec<RawSegment> = match serde_json::from_str(&json_owned) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!(
                        "[apple_speech] drain JSON パース失敗: {e} payload_bytes={}",
                        json_owned.len()
                    );
                    return Vec::new();
                }
            };

            raw.into_iter()
                .map(|r| TranscriptionSegment {
                    text: normalize_segment_text(&r.text),
                    start_ms: r.start_ms,
                    end_ms: r.end_ms,
                    source: self.source,
                    speaker: self.speaker.clone(),
                    is_error: None,
                })
                .collect()
        }
    }

    impl TranscriptionStream for AppleSpeechStream {
        fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
            if samples.is_empty() {
                return Ok(());
            }
            // Safety: samples は呼び出し中ずっと生存。bridge も valid。
            let rc =
                unsafe { meet_jerky_speech_feed(self.bridge, samples.as_ptr(), samples.len()) };
            if rc != 0 {
                return Err(format!("Apple Speech feed が失敗しました: rc={rc}"));
            }
            Ok(())
        }

        fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
            self.drain_inner()
        }

        fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
            if !self.finalized {
                let rc = unsafe { meet_jerky_speech_finalize(self.bridge) };
                if rc != 0 {
                    return Err(format!("Apple Speech finalize が失敗しました: rc={rc}"));
                }
                self.finalized = true;
            }
            Ok(self.drain_inner())
        }
    }

    impl Drop for AppleSpeechStream {
        fn drop(&mut self) {
            if !self.bridge.is_null() {
                if !self.finalized {
                    let rc = unsafe { meet_jerky_speech_finalize(self.bridge) };
                    if rc != 0 {
                        eprintln!("[apple_speech] drop finalize failed: rc={rc}");
                    }
                    self.finalized = true;
                }
                unsafe { meet_jerky_speech_destroy(self.bridge) };
                self.bridge = std::ptr::null_mut();
            }
        }
    }
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
}
