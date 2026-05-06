use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::audio_sample_helpers::{calculate_rms_from_sum, for_each_mono_sample};
use crate::audio_traits::AudioCapture;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use parking_lot::Mutex;
use ringbuf::{
    traits::{Producer, Split},
    HeapRb,
};
use tauri::Emitter;

/// フロントエンドに返すオーディオデバイス情報
#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub id: String,
}

// ─────────────────────────────────────────────
// CpalMicCapture
// ─────────────────────────────────────────────

/// cpal を使ったマイク入力キャプチャ
pub struct CpalMicCapture {
    device_id: Option<String>,
    stream: Option<cpal::Stream>,
    consumer: Option<ringbuf::HeapCons<f32>>,
    sample_rate: Option<u32>,
    level: Arc<AtomicU32>,
    running: Arc<AtomicBool>,
    level_thread: Option<std::thread::JoinHandle<()>>,
    dropped_samples: Arc<AtomicUsize>,
}

// cpal::Stream は macOS では Send ではないが、CpalMicCapture は
// Mutex で保護され、stream へのアクセスは常に排他的なので安全。
unsafe impl Send for CpalMicCapture {}

impl CpalMicCapture {
    pub fn new(device_id: Option<String>) -> Self {
        Self {
            device_id,
            stream: None,
            consumer: None,
            sample_rate: None,
            level: Arc::new(AtomicU32::new(0)),
            running: Arc::new(AtomicBool::new(false)),
            level_thread: None,
            dropped_samples: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_mic_input_stream_for_format<E>(
    sample_format: SampleFormat,
    device: &cpal::Device,
    stream_config: &cpal::StreamConfig,
    channels: usize,
    level: Arc<AtomicU32>,
    producer: Arc<Mutex<ringbuf::HeapProd<f32>>>,
    dropped_samples: Arc<AtomicUsize>,
    err_fn: E,
) -> Result<cpal::Stream, String>
where
    E: FnMut(cpal::StreamError) + Send + 'static,
{
    match sample_format {
        SampleFormat::F32 => build_mic_input_stream::<f32, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::F64 => build_mic_input_stream::<f64, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::I8 => build_mic_input_stream::<i8, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::I16 => build_mic_input_stream::<i16, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::I24 => build_mic_input_stream::<cpal::I24, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::I32 => build_mic_input_stream::<i32, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::I64 => build_mic_input_stream::<i64, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::U8 => build_mic_input_stream::<u8, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::U16 => build_mic_input_stream::<u16, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::U24 => build_mic_input_stream::<cpal::U24, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::U32 => build_mic_input_stream::<u32, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::U64 => build_mic_input_stream::<u64, E>(
            device,
            stream_config,
            channels,
            level,
            producer,
            dropped_samples.clone(),
            err_fn,
        ),
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => {
            Err(format!("未対応の入力サンプル形式です: {sample_format}"))
        }
        _ => Err(format!("未対応の入力サンプル形式です: {sample_format}")),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_mic_input_stream<T, E>(
    device: &cpal::Device,
    stream_config: &cpal::StreamConfig,
    channels: usize,
    level: Arc<AtomicU32>,
    producer: Arc<Mutex<ringbuf::HeapProd<f32>>>,
    dropped_samples: Arc<AtomicUsize>,
    err_fn: E,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
    E: FnMut(cpal::StreamError) + Send + 'static,
{
    device
        .build_input_stream(
            stream_config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut sum_squares = 0.0f32;
                let mut sample_count = 0usize;
                let mut producer_guard = producer.try_lock();
                let mut dropped = 0usize;

                for_each_mono_sample(data, channels, |sample| {
                    sum_squares += sample * sample;
                    sample_count += 1;

                    if let Some(guard) = producer_guard.as_mut() {
                        // バッファが満杯の場合は古いサンプルを捨てる（書き込まない）
                        if guard.try_push(sample).is_err() {
                            dropped += 1;
                        }
                    }
                });

                if dropped > 0 {
                    dropped_samples.fetch_add(dropped, Ordering::Relaxed);
                }

                let rms = calculate_rms_from_sum(sum_squares, sample_count);
                level.store(rms.to_bits(), Ordering::Relaxed);
            },
            err_fn,
            None, // タイムアウトなし
        )
        .map_err(|e| e.to_string())
}

impl AudioCapture for CpalMicCapture {
    fn start(&mut self, app_handle: tauri::AppHandle) -> Result<(), String> {
        // 既にキャプチャ中なら停止してから再開する
        if self.stream.is_some() {
            self.stop()?;
        }

        let host = cpal::default_host();

        // デバイスの選択
        let device = match &self.device_id {
            Some(id) => {
                let mut found = None;
                let devices = host
                    .input_devices()
                    .map_err(|e| format!("入力デバイスの列挙に失敗しました: {e}"))?;
                for d in devices {
                    if let Ok(device_id) = d.id() {
                        if device_id.to_string() == *id {
                            found = Some(d);
                            break;
                        }
                    }
                }
                found.ok_or_else(|| format!("デバイスが見つかりません: {id}"))?
            }
            None => host
                .default_input_device()
                .ok_or_else(|| "デフォルト入力デバイスがありません".to_string())?,
        };

        let config = device
            .default_input_config()
            .map_err(|e| format!("デフォルト入力設定の取得に失敗しました: {e}"))?;

        let sample_format = config.sample_format();
        let channels = config.channels() as usize;
        let device_sample_rate = config.sample_rate();
        self.sample_rate = Some(device_sample_rate);

        // リングバッファ: 16kHz mono で約5秒分 = 80000サンプル
        // 実際のサンプルレートが異なる場合でも十分なサイズを確保
        let buffer_size = 80_000usize;
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();
        let producer = Arc::new(Mutex::new(producer));

        let level = Arc::new(AtomicU32::new(0));
        let running = Arc::new(AtomicBool::new(true));

        self.level = Arc::clone(&level);
        self.running = Arc::clone(&running);
        self.consumer = Some(consumer);

        // オーディオコールバック用のクローン
        let level_for_callback = Arc::clone(&level);
        let producer_for_callback = Arc::clone(&producer);
        let dropped_for_callback = Arc::clone(&self.dropped_samples);
        let dropped_for_emitter = Arc::clone(&self.dropped_samples);

        let err_fn = |err: cpal::StreamError| {
            eprintln!("オーディオストリームエラー: {err}");
        };

        let stream_config: cpal::StreamConfig = config.into();
        let stream = build_mic_input_stream_for_format(
            sample_format,
            &device,
            &stream_config,
            channels,
            level_for_callback,
            producer_for_callback,
            dropped_for_callback,
            err_fn,
        )
        .map_err(|e| format!("入力ストリームの構築に失敗しました: {e}"))?;

        stream
            .play()
            .map_err(|e| format!("ストリームの開始に失敗しました: {e}"))?;

        self.stream = Some(stream);

        // バックグラウンドスレッドで audio-level イベントを送信
        let level_for_emitter = Arc::clone(&level);
        let running_for_emitter = Arc::clone(&running);
        let handle = std::thread::spawn(move || {
            while running_for_emitter.load(Ordering::SeqCst) {
                let bits = level_for_emitter.load(Ordering::Relaxed);
                let level_value = f32::from_bits(bits);
                let _ = app_handle.emit(
                    crate::audio_event::AUDIO_LEVEL_EVENT_NAME,
                    crate::audio_event::build_audio_level_event_payload(
                        crate::audio_event::AUDIO_SOURCE_MICROPHONE,
                        level_value,
                    ),
                );
                let dropped = dropped_for_emitter.swap(0, Ordering::Relaxed);
                if dropped > 0 {
                    eprintln!("[microphone] リングバッファ満杯で {dropped} sample を破棄しました");
                    let _ = app_handle.emit(
                        crate::audio_event::AUDIO_DROP_EVENT_NAME,
                        crate::audio_event::build_audio_drop_event_payload(
                            crate::audio_event::AUDIO_SOURCE_MICROPHONE,
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

        // ストリームをドロップして録音を停止
        self.stream = None;
        self.consumer = None;
        self.sample_rate = None;

        // レベルをリセット（0.0f32 のビットパターンは 0u32）
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
        "microphone"
    }

    fn current_level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

// ─────────────────────────────────────────────
// AudioStateHandle (Tauri managed state)
// ─────────────────────────────────────────────

/// 録音中の内部状態
///
/// 名前付きフィールドで各キャプチャソースを保持する。
pub struct AudioStateInner {
    pub microphone: Option<CpalMicCapture>,
    pub system_audio: Option<Box<dyn AudioCapture>>,
}

/// Tauri managed state として使うハンドル
pub struct AudioStateHandle(Mutex<AudioStateInner>);

impl AudioStateHandle {
    pub fn new() -> Self {
        Self(Mutex::new(AudioStateInner {
            microphone: None,
            system_audio: None,
        }))
    }

    /// 内部状態のロックを取得する
    pub fn lock_inner(&self) -> parking_lot::MutexGuard<'_, AudioStateInner> {
        self.0.lock()
    }

    /// マイクの現在のサンプルレートを取得する
    pub fn get_sample_rate(&self) -> Option<u32> {
        let inner = self.0.lock();
        inner.microphone.as_ref().and_then(|mic| mic.sample_rate())
    }

    /// マイクのリングバッファのコンシューマを取り出す（所有権の移動）
    pub fn take_consumer(&self) -> Option<ringbuf::HeapCons<f32>> {
        let mut inner = self.0.lock();
        inner
            .microphone
            .as_mut()
            .and_then(|mic| mic.take_consumer())
    }

    /// システム音声のサンプルレートを取得する
    pub fn get_system_audio_sample_rate(&self) -> Option<u32> {
        let inner = self.0.lock();
        inner
            .system_audio
            .as_ref()
            .and_then(|sys| sys.sample_rate())
    }

    /// システム音声のリングバッファのコンシューマを取り出す（所有権の移動）
    pub fn take_system_audio_consumer(&self) -> Option<ringbuf::HeapCons<f32>> {
        let mut inner = self.0.lock();
        inner
            .system_audio
            .as_mut()
            .and_then(|sys| sys.take_consumer())
    }
}

/// 利用可能な入力デバイスを列挙する
#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("入力デバイスの列挙に失敗しました: {e}"))?;

    let mut result = Vec::new();
    for (index, device) in devices.enumerate() {
        let name = device
            .description()
            .map(|desc| desc.name().to_string())
            .unwrap_or_else(|_| format!("Unknown Device {index}"));
        let id = device
            .id()
            .map(|device_id| device_id.to_string())
            .unwrap_or_else(|_| name.clone());
        result.push(AudioDevice { name, id });
    }

    Ok(result)
}

/// 録音を開始する
///
/// `device_id` が `None` の場合はデフォルトの入力デバイスを使用する。
/// 録音中は ~100ms ごとに `audio-level` イベントをフロントエンドに送信する。
#[tauri::command]
pub fn start_recording(
    device_id: Option<String>,
    state: tauri::State<'_, AudioStateHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut inner = state.0.lock();

    // 既に録音中なら停止してから再開する
    if let Some(ref mut mic) = inner.microphone {
        mic.stop()?;
    }
    inner.microphone = None;

    let mut mic = CpalMicCapture::new(device_id);
    mic.start(app)?;
    inner.microphone = Some(mic);

    Ok(())
}

/// PCMサンプルからRMSレベルを計算 (0.0〜1.0)
pub fn calculate_rms(samples: &[f32]) -> f32 {
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    calculate_rms_from_sum(sum, samples.len())
}

/// 録音を停止する
#[tauri::command]
pub fn stop_recording(state: tauri::State<'_, AudioStateHandle>) -> Result<(), String> {
    let mut inner = state.0.lock();

    if let Some(ref mut mic) = inner.microphone {
        mic.stop()?;
    }
    inner.microphone = None;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_sample_helpers::{
        calculate_rms_from_sum, for_each_mono_sample, normalize_sample_to_f32, sanitize_sample,
    };

    fn assert_close(actual: f32, expected: f32, epsilon: f32) {
        assert!(
            (actual - expected).abs() <= epsilon,
            "actual={actual}, expected={expected}, epsilon={epsilon}"
        );
    }

    #[test]
    fn test_rms_silence() {
        // All zeros should give 0.0
        let samples = vec![0.0f32; 100];
        assert_eq!(calculate_rms(&samples), 0.0);
    }

    #[test]
    fn test_rms_full_scale() {
        // All 1.0 should give 1.0
        let samples = vec![1.0f32; 100];
        assert!((calculate_rms(&samples) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_rms_known_value() {
        // A sine-like pattern: RMS of [1, -1, 1, -1] should be 1.0
        let samples = vec![1.0f32, -1.0, 1.0, -1.0];
        assert!((calculate_rms(&samples) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_rms_half_amplitude() {
        // All 0.5 should give 0.5
        let samples = vec![0.5f32; 100];
        assert!((calculate_rms(&samples) - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_rms_empty_samples() {
        // Empty input should return 0.0 (not NaN or panic)
        let samples: Vec<f32> = vec![];
        assert_eq!(calculate_rms(&samples), 0.0);
    }

    #[test]
    fn test_rms_clamped_to_one() {
        // Values > 1.0 should still produce a clamped result
        let samples = vec![2.0f32; 100];
        assert_eq!(calculate_rms(&samples), 1.0);
    }

    #[test]
    fn test_rms_nan_samples() {
        // NaN in input should return 0.0, not propagate NaN
        let samples = vec![f32::NAN, 0.5, 0.5];
        let result = calculate_rms(&samples);
        assert!(!result.is_nan(), "RMS should not be NaN");
        assert_eq!(result, 0.0);
    }

    #[test]
    fn test_rms_infinity_samples() {
        // Infinity in input should return 1.0 (clamped), not Inf
        let samples = vec![f32::INFINITY, 0.5];
        let result = calculate_rms(&samples);
        assert!(!result.is_infinite(), "RMS should not be Infinity");
        assert_eq!(result, 1.0);
    }

    #[test]
    fn test_normalize_sample_to_f32_for_i16() {
        assert_close(normalize_sample_to_f32(0i16), 0.0, f32::EPSILON);
        assert_close(normalize_sample_to_f32(i16::MIN), -1.0, f32::EPSILON);
        assert!(normalize_sample_to_f32(i16::MAX) > 0.999);
    }

    #[test]
    fn test_normalize_sample_to_f32_for_u16() {
        assert_close(normalize_sample_to_f32(32768u16), 0.0, f32::EPSILON);
        assert_close(normalize_sample_to_f32(u16::MIN), -1.0, f32::EPSILON);
        assert!(normalize_sample_to_f32(u16::MAX) > 0.999);
    }

    #[test]
    fn test_normalize_sample_to_f32_sanitizes_invalid_f32() {
        assert_eq!(normalize_sample_to_f32(f32::NAN), 0.0);
        assert_eq!(normalize_sample_to_f32(f32::INFINITY), 0.0);
        assert_eq!(normalize_sample_to_f32(f32::NEG_INFINITY), 0.0);
        assert_eq!(normalize_sample_to_f32(2.0f32), 1.0);
        assert_eq!(normalize_sample_to_f32(-2.0f32), -1.0);
    }

    #[test]
    fn test_for_each_mono_sample_keeps_f32_mono() {
        let mut mono = Vec::new();
        for_each_mono_sample(&[0.25f32, -0.75], 1, |sample| mono.push(sample));
        assert_eq!(mono, vec![0.25, -0.75]);
    }

    #[test]
    fn test_for_each_mono_sample_averages_i16_stereo() {
        let mut mono = Vec::new();
        for_each_mono_sample(&[i16::MAX, i16::MAX, i16::MIN, i16::MIN], 2, |sample| {
            mono.push(sample)
        });

        assert_eq!(mono.len(), 2);
        assert!(mono[0] > 0.999);
        assert_close(mono[1], -1.0, f32::EPSILON);
    }

    #[test]
    fn test_for_each_mono_sample_averages_u16_stereo_around_equilibrium() {
        let mut mono = Vec::new();
        for_each_mono_sample(&[u16::MIN, u16::MAX, 32768u16, 32768u16], 2, |sample| {
            mono.push(sample)
        });

        assert_eq!(mono.len(), 2);
        assert_close(mono[0], 0.0, 0.0001);
        assert_close(mono[1], 0.0, f32::EPSILON);
    }

    #[test]
    fn test_for_each_mono_sample_ignores_incomplete_multi_channel_frame() {
        let mut mono = Vec::new();
        for_each_mono_sample(&[0.25f32, 0.75, -1.0], 2, |sample| mono.push(sample));

        assert_eq!(mono, vec![0.5]);
    }

    #[test]
    fn test_for_each_mono_sample_ignores_zero_channels() {
        let mut mono = Vec::new();
        for_each_mono_sample(&[1.0f32, -1.0], 0, |sample| mono.push(sample));
        assert!(mono.is_empty());
    }

    #[test]
    fn test_audio_state_initial() {
        let state = AudioStateHandle::new();
        let inner = state.0.lock();
        // 初期状態ではマイクが存在しないこと
        assert!(inner.microphone.is_none());
        // システム音声も存在しないこと
        assert!(inner.system_audio.is_none());
    }

    #[test]
    fn test_cpal_mic_capture_initial_state() {
        let capture = CpalMicCapture::new(None);
        assert_eq!(capture.source_name(), "microphone");
        assert!(!capture.is_running());
        assert!(capture.sample_rate().is_none());
        assert_eq!(capture.current_level(), 0.0);
    }

    #[test]
    fn test_audio_state_dual_stream_independence() {
        // マイクとシステム音声のスロットが独立していることを確認
        let state = AudioStateHandle::new();
        {
            let mut inner = state.lock_inner();
            // マイクだけセットしてもシステム音声には影響しない
            inner.microphone = Some(CpalMicCapture::new(None));
            assert!(inner.microphone.is_some());
            assert!(inner.system_audio.is_none());
        }
        {
            let inner = state.lock_inner();
            // マイクはセット済み、システム音声はまだ None
            assert!(inner.microphone.is_some());
            assert!(inner.system_audio.is_none());
        }
    }

    #[test]
    fn test_cpal_mic_consumer_none_before_start() {
        let mut capture = CpalMicCapture::new(None);
        // start() 前は consumer が None であること
        assert!(capture.take_consumer().is_none());
    }

    #[test]
    fn sanitize_sample_returns_zero_for_nan() {
        assert_eq!(sanitize_sample(f32::NAN), 0.0);
    }

    #[test]
    fn sanitize_sample_returns_zero_for_positive_infinity() {
        assert_eq!(sanitize_sample(f32::INFINITY), 0.0);
    }

    #[test]
    fn sanitize_sample_returns_zero_for_negative_infinity() {
        assert_eq!(sanitize_sample(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn sanitize_sample_clamps_above_one_to_one() {
        assert_eq!(sanitize_sample(1.5), 1.0);
    }

    #[test]
    fn sanitize_sample_clamps_below_minus_one_to_minus_one() {
        assert_eq!(sanitize_sample(-1.5), -1.0);
    }

    #[test]
    fn sanitize_sample_passes_through_finite_values_in_range() {
        assert_eq!(sanitize_sample(0.0), 0.0);
        assert_eq!(sanitize_sample(0.5), 0.5);
        assert_eq!(sanitize_sample(-0.5), -0.5);
        assert_eq!(sanitize_sample(1.0), 1.0);
        assert_eq!(sanitize_sample(-1.0), -1.0);
    }

    #[test]
    fn calculate_rms_from_sum_returns_zero_for_zero_sample_count() {
        assert_eq!(calculate_rms_from_sum(10.0, 0), 0.0);
    }

    #[test]
    fn calculate_rms_from_sum_returns_zero_for_negative_sum_squares() {
        assert_eq!(calculate_rms_from_sum(-1.0, 4), 0.0);
    }

    #[test]
    fn calculate_rms_from_sum_clamps_above_one_to_one() {
        assert_eq!(calculate_rms_from_sum(100.0, 4), 1.0);
    }

    #[test]
    fn calculate_rms_from_sum_returns_zero_for_nan_sum_squares() {
        // NaN sum_squares は sqrt(NaN/count) = NaN を生み、is_nan() の早期 return で 0.0 になる。
        // is_nan() ブロックを消すと NaN.clamp(0, 1) の実装依存挙動で UI が化ける危険がある。
        assert_eq!(calculate_rms_from_sum(f32::NAN, 4), 0.0);
    }

    #[test]
    fn calculate_rms_from_sum_clamps_positive_infinity_to_one() {
        // +Inf.sqrt() は +Inf。is_nan() は false なので早期 return しない。
        // clamp(0, 1) で 1.0 に押さえられる。NaN → 0.0 と +Inf → 1.0 の非対称性は意図的。
        assert_eq!(calculate_rms_from_sum(f32::INFINITY, 4), 1.0);
    }

    #[test]
    fn calculate_rms_from_sum_returns_known_value_for_middle_range() {
        // sum=4.0, count=16 → sqrt(4.0 / 16.0) = sqrt(0.25) = 0.5
        // 中間値で sqrt 演算の数値精度退行を検知する。
        assert_close(calculate_rms_from_sum(4.0, 16), 0.5, 1e-6);
    }

    #[test]
    fn calculate_rms_from_sum_handles_single_sample_count() {
        // count=1 では sum / count = sum なので sqrt(sum) が直接 RMS になる。
        // sum=0.25 → sqrt(0.25) = 0.5。count=1 の境界で 0 除算や u32 cast の罠を検知する。
        assert_close(calculate_rms_from_sum(0.25, 1), 0.5, 1e-6);
    }

    #[test]
    fn calculate_rms_from_sum_at_clamp_upper_boundary() {
        // sum=1.0, count=1 → sqrt(1.0) = 1.0。clamp(0, 1) は 1.0 を 1.0 のまま通す。
        // 境界ジャスト値で「過剰な丸め」や「< 1.0 への押し下げ」リファクタを検知する。
        assert_close(calculate_rms_from_sum(1.0, 1), 1.0, 1e-6);
    }

    #[test]
    fn build_audio_drop_event_payload_includes_source_and_dropped_fields_with_microphone() {
        crate::audio_event::test_helpers::assert_drop_payload_includes_source_and_dropped_fields(
            "microphone",
            42,
        );
    }

    #[test]
    fn build_audio_drop_event_payload_serializes_zero_dropped_count_explicitly() {
        crate::audio_event::test_helpers::assert_drop_payload_serializes_zero_dropped_count_explicitly("microphone");
    }

    #[test]
    fn build_audio_drop_event_payload_handles_usize_max_boundary() {
        crate::audio_event::test_helpers::assert_drop_payload_handles_usize_max_boundary(
            "microphone",
        );
    }

    #[test]
    fn build_audio_drop_event_payload_passes_through_arbitrary_source_label() {
        crate::audio_event::test_helpers::assert_drop_payload_passes_through_arbitrary_source_labels("system_audio", "any_other_label");
    }

    #[test]
    fn build_audio_drop_event_payload_has_exactly_two_top_level_fields() {
        crate::audio_event::test_helpers::assert_drop_payload_has_exactly_two_top_level_fields(
            "microphone",
        );
    }

    #[test]
    fn audio_device_debug_contains_field_values_in_declaration_order() {
        let device = AudioDevice {
            name: "Built-in Microphone".to_string(),
            id: "device-001".to_string(),
        };
        let debug_str = format!("{:?}", device);
        assert!(debug_str.contains("AudioDevice"), "struct name in debug");
        assert!(debug_str.contains("name"), "field name 'name' in debug");
        assert!(debug_str.contains("id"), "field name 'id' in debug");
        assert!(
            debug_str.contains("Built-in Microphone"),
            "name value in debug"
        );
        assert!(debug_str.contains("device-001"), "id value in debug");
        assert!(
            debug_str.find("name").unwrap() < debug_str.find("id").unwrap(),
            "name field appears before id field: declaration order preserved"
        );
    }

    #[test]
    fn audio_device_clone_is_deep_and_does_not_mutate_original() {
        let original = AudioDevice {
            name: "Mic-A".to_string(),
            id: "id-A".to_string(),
        };
        let mut cloned = original.clone();
        cloned.name = "Mic-B".to_string();
        cloned.id = "id-B".to_string();
        let original_debug = format!("{:?}", original);
        assert!(
            original_debug.contains("AudioDevice"),
            "original struct name preserved"
        );
        assert!(
            !original_debug.contains("Mic-B"),
            "original should not contain cloned name"
        );
        assert!(
            !original_debug.contains("id-B"),
            "original should not contain cloned id"
        );
        assert!(
            original_debug.contains("Mic-A"),
            "original should contain original name"
        );
        assert!(
            original_debug.contains("id-A"),
            "original should contain original id"
        );
    }

    #[test]
    fn audio_device_serde_serialize_uses_default_snake_case_for_both_fields() {
        let device = AudioDevice {
            name: "Built-in Microphone".to_string(),
            id: "device-001".to_string(),
        };
        let value = serde_json::to_value(&device).expect("serialize should succeed");
        let obj = value.as_object().expect("should be object");
        assert_eq!(obj.len(), 2, "exactly 2 fields");
        assert!(obj.contains_key("name"), "key 'name' exists");
        assert_eq!(
            obj["name"],
            serde_json::json!("Built-in Microphone"),
            "name value matches"
        );
        assert!(obj.contains_key("id"), "key 'id' exists");
        assert_eq!(
            obj["id"],
            serde_json::json!("device-001"),
            "id value matches"
        );
        assert!(!obj.contains_key("Name"), "PascalCase key 'Name' absent");
        assert!(
            !obj.contains_key("deviceId"),
            "renamed key 'deviceId' absent"
        );
        assert!(
            !obj.contains_key("device_id"),
            "renamed key 'device_id' absent"
        );
        let json = serde_json::to_string(&device).expect("serialize to string should succeed");
        assert!(
            json.find("\"name\"").unwrap() < json.find("\"id\"").unwrap(),
            "\"name\" appears before \"id\" in JSON output"
        );
    }
}
