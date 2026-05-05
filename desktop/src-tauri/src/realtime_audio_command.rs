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
