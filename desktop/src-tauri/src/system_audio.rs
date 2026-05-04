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
use serde_json::json;
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(target_os = "macos")]
use screencapturekit::prelude::*;
#[cfg(target_os = "macos")]
use screencapturekit::CMFormatDescription;

#[cfg(target_os = "macos")]
use crate::audio::{calculate_rms, AudioCapture};

const F32_SAMPLE_BYTES: usize = std::mem::size_of::<f32>();

fn read_f32_ne(sample_bytes: &[u8]) -> f32 {
    f32::from_ne_bytes([
        sample_bytes[0],
        sample_bytes[1],
        sample_bytes[2],
        sample_bytes[3],
    ])
}

fn sanitize_pcm_sample(sample: f32) -> f32 {
    crate::audio_utils::sanitize_audio_sample(sample)
}

fn f32_pcm_bytes_to_mono(data: &[u8], channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }

    let Some(frame_byte_len) = channels.checked_mul(F32_SAMPLE_BYTES) else {
        return Vec::new();
    };

    if channels == 1 {
        return data
            .chunks_exact(F32_SAMPLE_BYTES)
            .map(read_f32_ne)
            .map(sanitize_pcm_sample)
            .collect();
    }

    data.chunks_exact(frame_byte_len)
        .map(|frame| {
            let sum = frame
                .chunks_exact(F32_SAMPLE_BYTES)
                .take(channels)
                .map(read_f32_ne)
                .map(sanitize_pcm_sample)
                .sum::<f32>();
            sum / channels as f32
        })
        .collect()
}

/// フォーマット検証の内部ロジック。純粋関数としてテスト可能。
/// ScreenCaptureKit が配信する Float32 / NativeEndian / 設定チャンネル数を確認する。
fn validate_audio_format_properties(
    is_float: bool,
    is_big_endian: bool,
    bits_per_channel: Option<u32>,
    channel_count: Option<u32>,
    expected_channels: u32,
) -> Result<(), &'static str> {
    if !is_float {
        return Err("非 f32 PCM フォーマット (kAudioFormatFlagIsFloat 未設定)");
    }
    if is_big_endian {
        return Err("BigEndian フォーマット (NativeEndian が必要)");
    }
    match bits_per_channel {
        Some(32) => {}
        Some(_) => return Err("bits_per_channel が 32 ではない"),
        None => return Err("bits_per_channel を取得できない"),
    }
    match channel_count {
        Some(ch) if ch == expected_channels => {}
        Some(_) => return Err("channel 数が設定値と不一致"),
        None => return Err("channel 数を取得できない"),
    }
    Ok(())
}

/// CMFormatDescription を受け取り ASBD 相当の検証を行う。
/// screencapturekit 1.5 で CMFormatDescription が公開されているため ASBD 検証が可能。
/// crate の音声フォーマット API が変化した場合はここを更新すること。
#[cfg(target_os = "macos")]
fn validate_audio_format_description(
    fmt: &CMFormatDescription,
    expected_channels: u32,
) -> Result<(), &'static str> {
    validate_audio_format_properties(
        fmt.audio_is_float(),
        fmt.audio_is_big_endian(),
        fmt.audio_bits_per_channel(),
        fmt.audio_channel_count(),
        expected_channels,
    )
}

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
                    "audio-level",
                    json!({ "level": level_value, "source": "system_audio" }),
                );
                let dropped = dropped_for_emitter.swap(0, Ordering::Relaxed);
                if dropped > 0 {
                    eprintln!(
                        "[system_audio] リングバッファ満杯で {dropped} sample を破棄しました"
                    );
                    let _ = app_handle.emit(
                        crate::audio_event::AUDIO_DROP_EVENT_NAME,
                        crate::audio_event::build_audio_drop_event_payload("system_audio", dropped),
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
    use super::*;
    use crate::audio_event::build_audio_drop_event_payload;

    fn pcm_bytes(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_ne_bytes())
            .collect()
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_keeps_mono_samples() {
        let data = pcm_bytes(&[0.25, -0.5, 1.0]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 1), vec![0.25, -0.5, 1.0]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_downmixes_stereo_frames() {
        let data = pcm_bytes(&[1.0, -1.0, 0.25, 0.75]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 2), vec![0.0, 0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_downmixes_multichannel_frames() {
        let data = pcm_bytes(&[1.0, 0.5, -0.5, 0.25, 0.25, 1.0]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 3), vec![1.0 / 3.0, 0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_ignores_zero_channels() {
        let data = pcm_bytes(&[1.0, -1.0]);

        assert!(f32_pcm_bytes_to_mono(&data, 0).is_empty());
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_ignores_short_and_trailing_bytes() {
        assert!(f32_pcm_bytes_to_mono(&[1, 2, 3], 1).is_empty());

        let mut data = pcm_bytes(&[0.5]);
        data.extend_from_slice(&[9, 8, 7]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 1), vec![0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_ignores_partial_multichannel_frame() {
        let mut data = pcm_bytes(&[0.25, 0.75, 1.0]);
        data.extend_from_slice(&[9, 8]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 2), vec![0.5]);
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_sanitizes_invalid_samples() {
        let data = pcm_bytes(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 2.0, -2.0]);

        assert_eq!(
            f32_pcm_bytes_to_mono(&data, 1),
            vec![0.0, 0.0, 0.0, 1.0, -1.0]
        );
    }

    #[test]
    fn test_f32_pcm_bytes_to_mono_sanitizes_before_downmix() {
        let data = pcm_bytes(&[f32::NAN, 1.0, 2.0, -2.0]);

        assert_eq!(f32_pcm_bytes_to_mono(&data, 2), vec![0.5, 0.0]);
    }

    // ── validate_audio_format_properties テスト ─────────────────────────────

    #[test]
    fn test_validate_audio_format_valid_f32_native_mono() {
        // Float32 / NativeEndian / 32bit / 1ch (設定値と一致) → Ok
        assert!(
            validate_audio_format_properties(true, false, Some(32), Some(1), 1).is_ok(),
            "正常な f32 モノラルフォーマットは Ok でなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_non_float() {
        // Integer PCM (is_float = false) → Err
        assert!(
            validate_audio_format_properties(false, false, Some(32), Some(1), 1).is_err(),
            "非 float フォーマットは拒否されなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_big_endian() {
        // BigEndian フォーマット → Err (Apple Silicon / Intel は NativeEndian)
        assert!(
            validate_audio_format_properties(true, true, Some(32), Some(1), 1).is_err(),
            "BigEndian フォーマットは拒否されなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_channel_count_mismatch() {
        // ステレオ (2ch) だが設定は 1ch → Err
        assert!(
            validate_audio_format_properties(true, false, Some(32), Some(2), 1).is_err(),
            "channel 数不一致は拒否されなければならない"
        );
    }

    #[test]
    fn test_validate_audio_format_rejects_unexpected_bits_per_channel() {
        // 16-bit PCM → Err (f32 = 32bit が必須)
        assert!(
            validate_audio_format_properties(true, false, Some(16), Some(1), 1).is_err(),
            "bits_per_channel が 32 以外は拒否されなければならない"
        );
    }

    // ── sanitize_pcm_sample 直接呼び出しテスト ─────────────────────────────

    #[test]
    fn sanitize_pcm_sample_returns_zero_for_nan() {
        assert_eq!(sanitize_pcm_sample(f32::NAN), 0.0);
    }

    #[test]
    fn sanitize_pcm_sample_returns_zero_for_positive_infinity() {
        assert_eq!(sanitize_pcm_sample(f32::INFINITY), 0.0);
    }

    #[test]
    fn sanitize_pcm_sample_returns_zero_for_negative_infinity() {
        assert_eq!(sanitize_pcm_sample(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn sanitize_pcm_sample_clamps_above_one_to_one() {
        assert_eq!(sanitize_pcm_sample(1.5), 1.0);
    }

    #[test]
    fn sanitize_pcm_sample_clamps_below_minus_one_to_minus_one() {
        assert_eq!(sanitize_pcm_sample(-1.5), -1.0);
    }

    #[test]
    fn sanitize_pcm_sample_passes_through_finite_values_in_range() {
        assert_eq!(sanitize_pcm_sample(0.0), 0.0);
        assert_eq!(sanitize_pcm_sample(0.5), 0.5);
        assert_eq!(sanitize_pcm_sample(-0.5), -0.5);
        assert_eq!(sanitize_pcm_sample(1.0), 1.0);
        assert_eq!(sanitize_pcm_sample(-1.0), -1.0);
    }

    // ── validate_audio_format_properties 未カバーケース ──────────────────────

    #[test]
    fn validate_audio_format_properties_rejects_when_bits_per_channel_unknown() {
        let result = validate_audio_format_properties(true, false, None, Some(1), 1);
        assert_eq!(result.unwrap_err(), "bits_per_channel を取得できない");
    }

    #[test]
    fn validate_audio_format_properties_rejects_when_channel_count_unknown() {
        let result = validate_audio_format_properties(true, false, Some(32), None, 1);
        assert_eq!(result.unwrap_err(), "channel 数を取得できない");
    }

    // 既存 5 件は is_err() のみでエラー文言未確認。本テストがそれを補強する。
    #[test]
    fn validate_audio_format_properties_error_messages_match_documented_strings_for_known_paths() {
        let non_float = validate_audio_format_properties(false, false, Some(32), Some(1), 1);
        assert_eq!(
            non_float.unwrap_err(),
            "非 f32 PCM フォーマット (kAudioFormatFlagIsFloat 未設定)"
        );

        let big_endian = validate_audio_format_properties(true, true, Some(32), Some(1), 1);
        assert_eq!(
            big_endian.unwrap_err(),
            "BigEndian フォーマット (NativeEndian が必要)"
        );

        let wrong_bits = validate_audio_format_properties(true, false, Some(16), Some(1), 1);
        assert_eq!(wrong_bits.unwrap_err(), "bits_per_channel が 32 ではない");

        let channel_mismatch = validate_audio_format_properties(true, false, Some(32), Some(2), 1);
        assert_eq!(channel_mismatch.unwrap_err(), "channel 数が設定値と不一致");
    }

    // ── read_f32_ne bit-pattern 直接テスト ───────────────────────────────────

    #[test]
    fn read_f32_ne_decodes_zero_bytes_to_zero_float() {
        // 4 byte 全 0 は f32 では 0.0 (どの endian でも符号なし)。
        // bit-pattern 読み取りの基本契約を固定する。
        let bytes = [0u8; 4];
        assert_eq!(read_f32_ne(&bytes), 0.0);
    }

    #[test]
    fn read_f32_ne_round_trips_one_point_zero() {
        // f32::to_ne_bytes と read_f32_ne (= f32::from_ne_bytes) の双方向 round-trip を確認。
        // from_le_bytes / from_be_bytes への誤リファクタを native endian 環境で検知する
        // (multibyte cross-platform でも to_ne_bytes ↔ from_ne_bytes は常に round-trip 不変)。
        let original: f32 = 1.0;
        let bytes = original.to_ne_bytes();
        assert_eq!(read_f32_ne(&bytes), original);
    }

    #[test]
    fn read_f32_ne_decodes_nan_bit_pattern_to_nan() {
        // NaN の bit-pattern は f32::NAN.to_ne_bytes() で取得し、read 結果が is_nan() を満たす。
        // sanitize_pcm_sample の前段で NaN bit-pattern が正しく NaN として読まれることが
        // 間接テストでは保証されない (sanitize で 0.0 に潰されてしまうため)。直接テストで保護。
        let bytes = f32::NAN.to_ne_bytes();
        assert!(read_f32_ne(&bytes).is_nan());
    }

    #[test]
    fn read_f32_ne_decodes_negative_infinity_bit_pattern() {
        // -Inf の bit-pattern が is_infinite() && is_sign_negative() を満たす。
        // f32 IEEE 754 表現の符号ビット保持を確認 (sanitize 前段の保証)。
        let bytes = f32::NEG_INFINITY.to_ne_bytes();
        let result = read_f32_ne(&bytes);
        assert!(result.is_infinite());
        assert!(result.is_sign_negative());
    }

    // ── validate_audio_format_properties short-circuit 順序契約 ──────────────

    #[test]
    fn validate_audio_format_properties_returns_first_violation_when_multiple_invalid() {
        // 4 関門 (is_float / is_big_endian / bits_per_channel / channel_count) すべて violation の場合、
        // 第 1 関門 (is_float check) が最初に発火し "非 f32 PCM..." を返す現挙動を固定。
        // 関門順序の入れ替えリファクタを CI で検知する装置として機能。
        let result = validate_audio_format_properties(
            /* is_float */ false,
            /* is_big_endian */ true,
            /* bits_per_channel */ Some(16),
            /* channel_count */ Some(99),
            /* expected_channels */ 2,
        );

        // 第 1 関門が最優先で発火することを文言完全一致で固定。
        assert_eq!(
            result,
            Err("非 f32 PCM フォーマット (kAudioFormatFlagIsFloat 未設定)")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_includes_source_and_dropped_fields_with_system_audio() {
        // T1: source="system_audio" + dropped=N で payload 構造を固定
        let payload = build_audio_drop_event_payload("system_audio", 42);
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some("system_audio"),
            "source field が文字列で含まれる契約"
        );
        assert_eq!(
            payload.get("dropped").and_then(|v| v.as_u64()),
            Some(42),
            "dropped field が u64 として含まれる契約"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_serializes_zero_dropped_count_explicitly() {
        // T2: dropped=0 でも payload 生成可能 (呼び出し側 if dropped > 0 で実際は呼ばれないが、関数自体は 0 を扱える純粋契約)
        let payload = build_audio_drop_event_payload("system_audio", 0);
        assert_eq!(payload.get("dropped").and_then(|v| v.as_u64()), Some(0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_handles_usize_max_boundary() {
        // T3: dropped=usize::MAX で u64 オーバーフローや panic しない契約
        let payload = build_audio_drop_event_payload("system_audio", usize::MAX);
        assert_eq!(
            payload.get("dropped").and_then(|v| v.as_u64()),
            Some(usize::MAX as u64),
            "usize::MAX が u64 として serde_json に渡せる契約"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_passes_through_arbitrary_source_label() {
        // T4: source 文字列は arbitrary な値が passthrough される契約 (関数自体は source を判定しない)
        let payload = build_audio_drop_event_payload("microphone", 1);
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some("microphone")
        );
        let payload2 = build_audio_drop_event_payload("any_other_label", 1);
        assert_eq!(
            payload2.get("source").and_then(|v| v.as_str()),
            Some("any_other_label"),
            "source は arbitrary passthrough = source を判定する誤改修への検知装置"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_audio_drop_event_payload_has_exactly_two_top_level_fields() {
        // T5: payload は source と dropped の 2 field のみ (将来 timestamp 等を追加する誤改修を field 数で検知)
        let payload = build_audio_drop_event_payload("system_audio", 5);
        let obj = payload.as_object().expect("payload は JSON object");
        assert_eq!(
            obj.len(),
            2,
            "top-level field は exactly 2 つ (source + dropped) の契約: 実際 = {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(obj.contains_key("source"));
        assert!(obj.contains_key("dropped"));
    }
}
