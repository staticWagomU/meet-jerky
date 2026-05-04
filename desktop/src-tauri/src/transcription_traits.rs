use std::sync::Arc;

use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

/// 1 つのストリーミング文字起こしセッションの設定。
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// 入力音声のサンプルレート。エンジン内部で必要に応じてリサンプルする。
    pub sample_rate: u32,
    /// 出力セグメントに付与する話者ラベル ("自分" / "相手側" など)。
    pub speaker: Option<String>,
    /// 入力音声ソース。ライブ UI がマイク/システム音声を表示上で識別するために使う。
    pub source: Option<TranscriptionSource>,
    /// 言語ヒント ("ja" / "en" / "auto")。エンジンが解釈する。
    pub language: Option<String>,
}

/// マイク / システム音声など、複数の音声ソースに対する文字起こしを行う
/// エンジンのファクトリ。
///
/// `start_stream` は呼び出すたびに独立した `TranscriptionStream` を返し、
/// 並行して複数のストリームを動かせる必要がある (マイク + システム音声)。
pub trait TranscriptionEngine: Send + Sync {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String>;
}

/// ストリーミング文字起こしの 1 セッションを表す。
///
/// 呼び出し元は raw PCM サンプルを `feed` で送り込み、確定した
/// セグメントを `drain_segments` で非同期に取り出す。`finalize` で
/// 残りのバッファをフラッシュして最終セグメントを得る。
///
/// 実装はサンプルレート変換やチャンク化、API 呼び出しなどの
/// エンジン固有の責務をすべて内部に閉じ込める。
pub trait TranscriptionStream: Send {
    /// `StreamConfig::sample_rate` で指定したレートのサンプルを送り込む。
    fn feed(&mut self, samples: &[f32]) -> Result<(), String>;

    /// これまでに確定したセグメントを取り出す (非ブロッキング)。
    fn drain_segments(&mut self) -> Vec<TranscriptionSegment>;

    /// 残りのバッファを処理し、最終セグメントを返す。
    /// 呼び出し後はストリームを使わない。
    fn finalize(self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String>;
}
