use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionSource {
    Microphone,
    SystemAudio,
}

/// 文字起こし結果の1セグメント
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TranscriptionSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>, // "自分" (mic) or "相手側" (system audio)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// 文字起こし worker から UI へ通知するエラー payload。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TranscriptionErrorPayload {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TranscriptionSource>,
}

/// 利用可能なモデルの情報
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub display_name: String,
    pub size_mb: u64,
    pub url: String,
}
