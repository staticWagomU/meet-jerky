//! ScreenCaptureKit を使用したシステム音声キャプチャ (macOS only)
//!
//! ScreenCaptureKit はディスプレイのキャプチャストリームからシステム音声を取得する。
//! ビデオは不要だが、ScreenCaptureKit のフィルタにはディスプレイが必要。

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
#[cfg(target_os = "macos")]
use std::sync::{Arc, Once};
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
use parking_lot::Mutex;
#[cfg(target_os = "macos")]
use ringbuf::{
    traits::{Producer, Split},
    HeapRb,
};
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(target_os = "macos")]
use crate::audio::calculate_rms;
use crate::audio_traits::AudioCapture;
#[cfg(target_os = "macos")]
use crate::system_audio_format::validate_audio_format_description;
#[cfg(target_os = "macos")]
use crate::system_audio_pcm::f32_pcm_bytes_to_mono;
#[cfg(target_os = "macos")]
use screencapturekit::prelude::*;

/// フォーマット不一致の警告を 1 度だけ出力するための制御フラグ。
#[cfg(target_os = "macos")]
static FORMAT_WARN_ONCE: Once = Once::new();

#[cfg(target_os = "macos")]
fn warn_system_audio_format_once(app_handle: &tauri::AppHandle, message: &'static str) {
    let app_handle = app_handle.clone();
    FORMAT_WARN_ONCE.call_once(move || {
        eprintln!("[system_audio] 入力フォーマット検証失敗: {message}。バッファを破棄します。");
        let _ = app_handle.emit("system-audio-format-warning", message);
    });
}

// ─────────────────────────────────────────────
// ScreenCaptureKitCapture
// ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub struct ScreenCaptureKitCapture {
    consumer: Option<ringbuf::HeapCons<f32>>,
    sample_rate: Option<u32>,
    level: Arc<AtomicU32>,
    running: Arc<AtomicBool>,
    stream: Option<SCStream>,
    level_thread: Option<std::thread::JoinHandle<()>>,
    // transcription loop が遅延した時のリングバッファ満杯発生を可視化するためのカウンタ
    dropped_samples: Arc<AtomicUsize>,
}

#[cfg(target_os = "macos")]
unsafe impl Send for ScreenCaptureKitCapture {}

#[cfg(target_os = "macos")]
impl ScreenCaptureKitCapture {
    pub fn new() -> Self {
        Self {
            consumer: None,
            sample_rate: None,
            level: Arc::new(AtomicU32::new(0)),
            running: Arc::new(AtomicBool::new(false)),
            stream: None,
            level_thread: None,
            dropped_samples: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for ScreenCaptureKitCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// システム音声のサンプルレート
#[cfg(target_os = "macos")]
const SYSTEM_AUDIO_SAMPLE_RATE: u32 = 48_000;

/// システム音声のチャンネル数 (モノラル)
#[cfg(target_os = "macos")]
const SYSTEM_AUDIO_CHANNELS: i32 = 1;

#[cfg(target_os = "macos")]
impl AudioCapture for ScreenCaptureKitCapture {
    fn start(&mut self, app_handle: tauri::AppHandle) -> Result<(), String> {
        // 既にキャプチャ中なら停止してから再開する
        if self.stream.is_some() {
            self.stop()?;
        }

        // 共有可能なコンテンツを取得
        let content = SCShareableContent::get()
            .map_err(|e| format!("共有可能なコンテンツの取得に失敗しました: {e}"))?;

        // 最初のディスプレイを取得（音声キャプチャにはディスプレイが必要）
        let displays = content.displays();
        let display = displays
            .into_iter()
            .next()
            .ok_or_else(|| "ディスプレイが見つかりません".to_string())?;

        // コンテンツフィルタを作成
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        // ストリーム設定を作成
        // ビデオは最小限に、音声キャプチャのみ必要
        let config = SCStreamConfiguration::new()
            .with_width(2)
            .with_height(2)
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(SYSTEM_AUDIO_SAMPLE_RATE as i32)
            .with_channel_count(SYSTEM_AUDIO_CHANNELS);

        self.sample_rate = Some(SYSTEM_AUDIO_SAMPLE_RATE);

        // リングバッファ: 48kHz mono で約5秒分
        let buffer_size = (SYSTEM_AUDIO_SAMPLE_RATE as usize) * 5;
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();
        let producer = Arc::new(Mutex::new(producer));

        let level = Arc::new(AtomicU32::new(0));
        let running = Arc::new(AtomicBool::new(true));

        self.level = Arc::clone(&level);
        self.running = Arc::clone(&running);
        self.consumer = Some(consumer);

        let dropped_samples = Arc::new(AtomicUsize::new(0));
        self.dropped_samples = Arc::clone(&dropped_samples);

        // SCStream を作成
        let mut stream = SCStream::new(&filter, &config);

        // オーディオ出力ハンドラをクロージャで登録
        let app_handle_for_warning = app_handle.clone();
        let level_for_callback = Arc::clone(&level);
        let producer_for_callback = Arc::clone(&producer);
        let dropped_for_callback = Arc::clone(&dropped_samples);

        stream.add_output_handler(
            move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
                if of_type != SCStreamOutputType::Audio {
                    return;
                }

                // オーディオバッファリストを取得
                let audio_buffer_list = match sample.audio_buffer_list() {
                    Some(list) => list,
                    None => return,
                };

                if let Some(fmt) = sample.format_description() {
                    if let Err(reason) =
                        validate_audio_format_description(&fmt, SYSTEM_AUDIO_CHANNELS as u32)
                    {
                        warn_system_audio_format_once(&app_handle_for_warning, reason);
                        return;
                    }
                } else {
                    warn_system_audio_format_once(
                        &app_handle_for_warning,
                        "CMFormatDescription を取得できません",
                    );
                    return;
                }

                // 各バッファから f32 PCM サンプルを抽出する。
                let mut mono_samples: Vec<f32> = Vec::new();

                for buffer in audio_buffer_list.iter() {
                    let data = buffer.data();
                    let channels = buffer.number_channels as usize;

                    mono_samples.extend(f32_pcm_bytes_to_mono(data, channels));
                }

                if mono_samples.is_empty() {
                    return;
                }

                // RMS レベルを計算
                let rms = calculate_rms(&mono_samples);
                level_for_callback.store(rms.to_bits(), Ordering::Relaxed);

                // リングバッファにサンプルを書き込む
                if let Some(mut guard) = producer_for_callback.try_lock() {
                    let mut dropped = 0usize;
                    for &sample in &mono_samples {
                        if guard.try_push(sample).is_err() {
                            dropped += 1;
                        }
                    }
                    if dropped > 0 {
                        dropped_for_callback.fetch_add(dropped, Ordering::Relaxed);
                    }
                }
            },
            SCStreamOutputType::Audio,
        );

        // キャプチャを開始
        stream
            .start_capture()
            .map_err(|e| format!("相手側音声の取得開始に失敗しました: {e}"))?;

        self.stream = Some(stream);

        // バックグラウンドスレッドで audio-level イベントを送信
        let level_for_emitter = Arc::clone(&level);
        let running_for_emitter = Arc::clone(&running);
        let dropped_for_emitter = Arc::clone(&dropped_samples);
        let handle = std::thread::spawn(move || {
            while running_for_emitter.load(Ordering::SeqCst) {
                let bits = level_for_emitter.load(Ordering::Relaxed);
                let level_value = f32::from_bits(bits);
                let _ = app_handle.emit(
                    crate::audio_event::AUDIO_LEVEL_EVENT_NAME,
                    crate::audio_event::build_audio_level_event_payload(
                        crate::audio_event::AUDIO_SOURCE_SYSTEM_AUDIO,
                        level_value,
                    ),
                );
                let dropped = dropped_for_emitter.swap(0, Ordering::Relaxed);
                if dropped > 0 {
                    eprintln!(
                        "[system_audio] リングバッファ満杯で {dropped} sample を破棄しました"
                    );
                    let _ = app_handle.emit(
                        crate::audio_event::AUDIO_DROP_EVENT_NAME,
                        crate::audio_event::build_audio_drop_event_payload(
                            crate::audio_event::AUDIO_SOURCE_SYSTEM_AUDIO,
                            dropped,
                        ),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        self.level_thread = Some(handle);

        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        // running フラグをオフにしてレベル送信スレッドを停止
        self.running.store(false, Ordering::SeqCst);

        // ストリームを停止
        if let Some(ref stream) = self.stream {
            let _ = stream.stop_capture();
        }
        self.stream = None;
        self.consumer = None;
        self.sample_rate = None;

        // レベルをリセット
        self.level.store(0, Ordering::Relaxed);

        // レベル送信スレッドの終了を待つ
        if let Some(handle) = self.level_thread.take() {
            let _ = handle.join();
        }

        Ok(())
    }

    fn take_consumer(&mut self) -> Option<ringbuf::HeapCons<f32>> {
        self.consumer.take()
    }

    fn sample_rate(&self) -> Option<u32> {
        self.sample_rate
    }

    fn source_name(&self) -> &str {
        "system_audio"
    }

    fn current_level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

// ─────────────────────────────────────────────
// Tauri コマンド
// ─────────────────────────────────────────────

/// システム音声キャプチャを開始する (macOS only)
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn start_system_audio(
    state: tauri::State<'_, crate::audio::AudioStateHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut inner = state.lock_inner();

    // 既にキャプチャ中なら停止してから再開する
    if let Some(ref mut sys) = inner.system_audio {
        sys.stop()?;
    }
    inner.system_audio = None;

    let mut capture = ScreenCaptureKitCapture::new();
    capture.start(app)?;
    inner.system_audio = Some(Box::new(capture));

    Ok(())
}

/// システム音声キャプチャを停止する (macOS only)
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn stop_system_audio(
    state: tauri::State<'_, crate::audio::AudioStateHandle>,
) -> Result<(), String> {
    let mut inner = state.lock_inner();

    if let Some(ref mut sys) = inner.system_audio {
        sys.stop()?;
    }
    inner.system_audio = None;

    Ok(())
}

/// システム音声キャプチャを開始する (非macOS用のスタブ)
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn start_system_audio(
    _state: tauri::State<'_, crate::audio::AudioStateHandle>,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    Err("相手側音声の取得は macOS でのみ利用可能です".to_string())
}

/// システム音声キャプチャを停止する (非macOS用のスタブ)
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn stop_system_audio(
    _state: tauri::State<'_, crate::audio::AudioStateHandle>,
) -> Result<(), String> {
    Err("相手側音声の取得は macOS でのみ利用可能です".to_string())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_includes_source_and_dropped_fields_with_system_audio() {
        crate::audio_event::test_helpers::assert_drop_payload_includes_source_and_dropped_fields(
            "system_audio",
            42,
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_serializes_zero_dropped_count_explicitly() {
        crate::audio_event::test_helpers::assert_drop_payload_serializes_zero_dropped_count_explicitly("system_audio");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_handles_usize_max_boundary() {
        crate::audio_event::test_helpers::assert_drop_payload_handles_usize_max_boundary(
            "system_audio",
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_passes_through_arbitrary_source_label() {
        crate::audio_event::test_helpers::assert_drop_payload_passes_through_arbitrary_source_labels("microphone", "any_other_label");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_has_exactly_two_top_level_fields() {
        crate::audio_event::test_helpers::assert_drop_payload_has_exactly_two_top_level_fields(
            "system_audio",
        );
    }
}
