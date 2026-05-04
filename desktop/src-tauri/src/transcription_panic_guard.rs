use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::Emitter;

use crate::transcription::{run_transcription_loop, TranscriptionLoopConfig};
use crate::transcription_error_payload::build_worker_panic_error_payload;

pub(crate) fn run_transcription_worker_with_panic_guard(worker: TranscriptionLoopConfig) {
    let running = Arc::clone(&worker.running);
    let app = worker.app.clone();
    let source = worker.source;

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_transcription_loop(worker);
    }));

    if result.is_err() {
        running.store(false, Ordering::SeqCst);
        eprintln!("[transcription] worker panic");
        let _ = app.emit(
            "transcription-error",
            build_worker_panic_error_payload(Some(source)),
        );
    }
}
