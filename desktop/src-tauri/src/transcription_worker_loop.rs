use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ringbuf::traits::{Consumer, Observer};
use tauri::Emitter;

use crate::transcription_emission::emit_segments;
use crate::transcription_error_payload::{
    build_transcription_error_payload, should_emit_realtime_stream_error,
};
use crate::transcription_traits::TranscriptionStream;
use crate::transcription_types::TranscriptionSource;

pub(crate) struct TranscriptionLoopConfig {
    pub(crate) consumer: ringbuf::HeapCons<f32>,
    pub(crate) source: TranscriptionSource,
    pub(crate) stream: Box<dyn TranscriptionStream>,
    pub(crate) running: Arc<AtomicBool>,
    pub(crate) app: tauri::AppHandle,
    pub(crate) session_manager: Arc<crate::session_manager::SessionManager>,
    pub(crate) stream_started_at_secs: u64,
}

pub(crate) fn run_transcription_loop(cfg: TranscriptionLoopConfig) {
    let TranscriptionLoopConfig {
        mut consumer,
        source,
        mut stream,
        running,
        app,
        session_manager,
        stream_started_at_secs,
    } = cfg;

    let mut read_buffer: Vec<f32> = vec![0.0; 4096];
    let mut feed_failed = false;

    while running.load(Ordering::SeqCst) {
        let available = consumer.occupied_len();
        if available == 0 {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }

        let to_read = available.min(read_buffer.len());
        let read_count = consumer.pop_slice(&mut read_buffer[..to_read]);

        if read_count == 0 {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }

        let samples = &read_buffer[..read_count];

        if let Err(e) = stream.feed(samples) {
            if should_emit_realtime_stream_error(&e) {
                eprintln!("文字起こしエラー: {e}");
                let _ = app.emit(
                    "transcription-error",
                    build_transcription_error_payload(e, Some(source)),
                );
            }
            running.store(false, Ordering::SeqCst);
            feed_failed = true;
            emit_segments(
                stream.drain_segments(),
                &app,
                &session_manager,
                stream_started_at_secs,
            );
            break;
        }

        emit_segments(
            stream.drain_segments(),
            &app,
            &session_manager,
            stream_started_at_secs,
        );

        // CPU spin 防止のための短い yield — データがある間も常時 polling しない
        std::thread::sleep(Duration::from_millis(5));
    }

    if feed_failed {
        return;
    }

    // 停止フラグが立ったら、残ったバッファをフラッシュして最終セグメントを emit する。
    match stream.finalize() {
        Ok(remaining) => {
            emit_segments(remaining, &app, &session_manager, stream_started_at_secs);
        }
        Err(e) => {
            if should_emit_realtime_stream_error(&e) {
                eprintln!("文字起こしの finalize に失敗しました: {e}");
                let _ = app.emit(
                    "transcription-error",
                    build_transcription_error_payload(e, Some(source)),
                );
            }
        }
    }
}
