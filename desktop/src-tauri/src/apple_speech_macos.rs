//! Apple SpeechAnalyzer (macOS 26+) の FFI ブリッジ実装。
//!
//! `apple_speech.rs` から `#[cfg(target_os = "macos")]` の `mod macos` を切り出し、
//! macOS 専用 ABI 詳細 (extern "C" + SpeechBridge + AppleSpeechStream + RAII) を集約する。
//! caller は `apple_speech.rs` の `AppleSpeechEngine::start_stream` のみ。

use std::ffi::{c_char, CStr, CString};

use serde::Deserialize;

use crate::apple_speech::{language_to_locale, normalize_segment_text};
use crate::transcription_traits::{StreamConfig, TranscriptionStream};
use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

#[repr(C)]
pub struct SpeechBridge {
    _private: [u8; 0],
}

extern "C" {
    fn meet_jerky_speech_create(locale_id: *const c_char, sample_rate: f64) -> *mut SpeechBridge;
    fn meet_jerky_speech_feed(bridge: *mut SpeechBridge, samples: *const f32, len: usize) -> i32;
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
        let c_locale =
            CString::new(locale).map_err(|e| format!("ロケール文字列の変換に失敗しました: {e}"))?;

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
        let rc = unsafe { meet_jerky_speech_feed(self.bridge, samples.as_ptr(), samples.len()) };
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
