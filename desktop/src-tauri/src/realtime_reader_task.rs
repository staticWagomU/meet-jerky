use std::sync::Arc;

use futures_util::stream::SplitStream;
use futures_util::StreamExt;
use parking_lot::Mutex;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

/// ws_stream.split() の rx 側 = realtime engine 共通の WS reader stream。
pub(crate) type WsReader = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

/// Realtime engine 共通: WS から受信したメッセージを順次 on_event に渡す。
/// engine_label は push_error の format に使う ("ElevenLabs" / "OpenAI" 等)。
/// on_event は WS protocol 固有の handle_event を closure で受ける。
pub(crate) async fn run_reader_task<F>(
    mut ws_rx: WsReader,
    pending: Arc<Mutex<Vec<TranscriptionSegment>>>,
    speaker: Option<String>,
    source: Option<TranscriptionSource>,
    engine_label: &'static str,
    on_event: F,
) where
    F: Fn(
            &str,
            &Arc<Mutex<Vec<TranscriptionSegment>>>,
            &Option<String>,
            Option<TranscriptionSource>,
        ) + Send
        + 'static,
{
    while let Some(msg) = ws_rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                crate::realtime_error_helpers::push_error(
                    engine_label,
                    &pending,
                    &speaker,
                    source,
                    e.to_string(),
                );
                break;
            }
        };
        match msg {
            Message::Text(text) => on_event(&text, &pending, &speaker, source),
            Message::Close(_) => break,
            _ => {}
        }
    }
}
