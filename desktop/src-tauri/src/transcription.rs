// ─────────────────────────────────────────────
// データ型 (transcription_types.rs に分離、ここから互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

// ─────────────────────────────────────────────
// TranscriptionEngine / TranscriptionStream トレイト (transcription_traits.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};

// ─────────────────────────────────────────────
// WhisperStream (transcription_whisper_stream.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_whisper_stream::WhisperStream;

// ─────────────────────────────────────────────
// TranscriptionManager / TranscriptionStateHandle (transcription_manager.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_manager::TranscriptionStateHandle;

// ─────────────────────────────────────────────
// Tauri コマンド
// ─────────────────────────────────────────────

/// Whisper の入力サンプルレート（16kHz）
pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16_000;

// ─────────────────────────────────────────────
// TranscriptionLoopConfig (transcription_worker_loop.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub(crate) use crate::transcription_worker_loop::TranscriptionLoopConfig;
