use tauri::AppHandle;

// ─────────────────────────────────────────────
// AudioCapture トレイト
// ─────────────────────────────────────────────

/// 音声キャプチャの抽象化。マイク(cpal)やシステム音声(ScreenCaptureKit)が実装する。
#[allow(dead_code)]
pub trait AudioCapture: Send {
    /// キャプチャ開始
    fn start(&mut self, app_handle: AppHandle) -> Result<(), String>;
    /// キャプチャ停止
    fn stop(&mut self) -> Result<(), String>;
    /// リングバッファの消費者を取得
    fn take_consumer(&mut self) -> Option<ringbuf::HeapCons<f32>>;
    /// サンプルレート取得
    fn sample_rate(&self) -> Option<u32>;
    /// ソース名 ("microphone" or "system_audio")
    fn source_name(&self) -> &str;
    /// 現在のRMSレベル (0.0-1.0)
    fn current_level(&self) -> f32;
    /// キャプチャ中かどうか
    fn is_running(&self) -> bool;
}
