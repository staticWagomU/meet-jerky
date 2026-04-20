use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use ringbuf::traits::{Consumer, Observer};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use tauri::Emitter;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// ─────────────────────────────────────────────
// データ型
// ─────────────────────────────────────────────

/// 文字起こし結果の1セグメント
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>, // "自分" (mic) or "相手" (system audio)
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

// ─────────────────────────────────────────────
// TranscriptionEngine トレイト
// ─────────────────────────────────────────────

pub trait TranscriptionEngine: Send + Sync {
    fn transcribe(&self, audio: &[f32]) -> Result<Vec<TranscriptionSegment>, String>;
}

// ─────────────────────────────────────────────
// WhisperLocal 実装
// ─────────────────────────────────────────────

pub struct WhisperLocal {
    ctx: WhisperContext,
}

impl WhisperLocal {
    pub fn new(model_path: &str) -> Result<Self, String> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| format!("Whisper モデルの読み込みに失敗しました: {e}"))?;
        Ok(Self { ctx })
    }
}

impl TranscriptionEngine for WhisperLocal {
    fn transcribe(&self, audio: &[f32]) -> Result<Vec<TranscriptionSegment>, String> {
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| format!("WhisperState の作成に失敗しました: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("auto"));
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_no_context(true);

        state
            .full(params, audio)
            .map_err(|e| format!("Whisper 推論に失敗しました: {e}"))?;

        let num_segments = state.full_n_segments();
        let mut segments = Vec::new();

        for i in 0..num_segments {
            let segment = match state.get_segment(i) {
                Some(seg) => seg,
                None => continue,
            };

            let text = segment
                .to_str_lossy()
                .map_err(|e| format!("セグメントテキストの取得に失敗しました: {e}"))?
                .trim()
                .to_string();

            let start_ts = segment.start_timestamp();
            let end_ts = segment.end_timestamp();

            // whisper のタイムスタンプは centiseconds（10ms 単位）
            segments.push(TranscriptionSegment {
                text,
                start_ms: start_ts * 10,
                end_ms: end_ts * 10,
                speaker: None,
            });
        }

        Ok(segments)
    }
}

// ─────────────────────────────────────────────
// ModelManager
// ─────────────────────────────────────────────

pub struct ModelManager {
    models_dir: PathBuf,
}

impl ModelManager {
    pub fn new() -> Self {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("meet-jerky")
            .join("models");
        Self { models_dir }
    }

    /// テスト用: 任意のディレクトリを指定して ModelManager を作成する
    #[cfg(test)]
    pub fn with_dir(models_dir: PathBuf) -> Self {
        Self { models_dir }
    }

    pub fn get_model_path(&self, model_name: &str) -> PathBuf {
        self.models_dir.join(format!("ggml-{model_name}.bin"))
    }

    pub fn is_model_downloaded(&self, model_name: &str) -> bool {
        self.get_model_path(model_name).exists()
    }

    /// Hugging Face からモデルをストリーミングダウンロードする
    pub fn download_model(
        &self,
        model_name: &str,
        on_progress: impl Fn(f64),
    ) -> Result<PathBuf, String> {
        use std::io::{Read, Write};

        let url = format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model_name}.bin"
        );
        let model_path = self.get_model_path(model_name);

        // ディレクトリがなければ作成
        if let Some(parent) = model_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("モデルディレクトリの作成に失敗しました: {e}"))?;
        }

        on_progress(0.0);

        let response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(1800))
            .build()
            .map_err(|e| format!("HTTPクライアントの作成に失敗しました: {e}"))?
            .get(&url)
            .send()
            .map_err(|e| format!("モデルのダウンロードリクエストに失敗しました: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "モデルのダウンロードに失敗しました: HTTP {}",
                response.status()
            ));
        }

        let total_size = response.content_length();

        // 一時ファイルにストリーミング書き込み
        let tmp_path = model_path.with_extension("bin.tmp");
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("一時ファイルの作成に失敗しました: {e}"))?;

        let mut downloaded: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024]; // 64KB チャンク
        let mut reader = response;

        loop {
            let bytes_read = reader
                .read(&mut buf)
                .map_err(|e| format!("モデルデータの受信に失敗しました: {e}"))?;
            if bytes_read == 0 {
                break;
            }
            file.write_all(&buf[..bytes_read])
                .map_err(|e| format!("モデルファイルの書き込みに失敗しました: {e}"))?;
            downloaded += bytes_read as u64;

            if let Some(total) = total_size {
                on_progress(downloaded as f64 / total as f64);
            }
        }

        file.flush()
            .map_err(|e| format!("ファイルのフラッシュに失敗しました: {e}"))?;
        drop(file);

        // ダウンロード完了後にリネーム（中断対策）
        std::fs::rename(&tmp_path, &model_path)
            .map_err(|e| format!("モデルファイルのリネームに失敗しました: {e}"))?;

        on_progress(1.0);

        Ok(model_path)
    }

    /// 利用可能なモデル一覧を返す
    pub fn list_available_models() -> Vec<ModelInfo> {
        vec![
            ModelInfo {
                name: "tiny".to_string(),
                display_name: "Tiny (75MB)".to_string(),
                size_mb: 75,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
                    .to_string(),
            },
            ModelInfo {
                name: "base".to_string(),
                display_name: "Base (142MB)".to_string(),
                size_mb: 142,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
                    .to_string(),
            },
            ModelInfo {
                name: "small".to_string(),
                display_name: "Small (466MB)".to_string(),
                size_mb: 466,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
                    .to_string(),
            },
            ModelInfo {
                name: "medium".to_string(),
                display_name: "Medium (1.5GB)".to_string(),
                size_mb: 1500,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
                    .to_string(),
            },
            ModelInfo {
                name: "large-v3".to_string(),
                display_name: "Large v3 (3.1GB)".to_string(),
                size_mb: 3100,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
                    .to_string(),
            },
        ]
    }
}

// ─────────────────────────────────────────────
// TranscriptionManager
// ─────────────────────────────────────────────

pub struct TranscriptionManager {
    engine: Option<Arc<dyn TranscriptionEngine>>,
    running: Arc<AtomicBool>,
    model_manager: ModelManager,
}

impl TranscriptionManager {
    pub fn new() -> Self {
        Self {
            engine: None,
            running: Arc::new(AtomicBool::new(false)),
            model_manager: ModelManager::new(),
        }
    }

    /// エンジンが読み込まれているか
    pub fn is_engine_loaded(&self) -> bool {
        self.engine.is_some()
    }

    /// 文字起こしが実行中か
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// モデルを読み込む（まだ読み込まれていない場合）
    pub fn load_model(&mut self, model_name: &str) -> Result<(), String> {
        let model_path = self.model_manager.get_model_path(model_name);
        if !model_path.exists() {
            return Err(format!(
                "モデルがダウンロードされていません: {model_name}"
            ));
        }

        let path_str = model_path
            .to_str()
            .ok_or_else(|| "モデルパスの変換に失敗しました".to_string())?;
        let engine = WhisperLocal::new(path_str)?;
        self.engine = Some(Arc::new(engine));
        Ok(())
    }

    /// 停止フラグを取得する（スレッド間共有用）
    pub fn running_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.running)
    }

    /// 文字起こしを停止する
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────
// Tauri managed state
// ─────────────────────────────────────────────

pub struct TranscriptionStateHandle(pub Mutex<TranscriptionManager>);

impl TranscriptionStateHandle {
    pub fn new() -> Self {
        Self(Mutex::new(TranscriptionManager::new()))
    }
}

// ─────────────────────────────────────────────
// Tauri コマンド
// ─────────────────────────────────────────────

/// 利用可能なモデル一覧を返す
#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    ModelManager::list_available_models()
}

/// モデルがダウンロード済みかを確認する
#[tauri::command]
pub fn is_model_downloaded(model_name: String) -> bool {
    let manager = ModelManager::new();
    manager.is_model_downloaded(&model_name)
}

/// モデルをダウンロードする（プログレスイベントを送信）
#[tauri::command]
pub async fn download_model(
    model_name: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let model_name_for_progress = model_name.clone();
    let app_clone = app.clone();

    // ダウンロードはブロッキングI/Oなので専用スレッドで実行
    let result = tokio::task::spawn_blocking(move || {
        let manager = ModelManager::new();
        let model_name_ref = model_name_for_progress.clone();
        manager.download_model(&model_name_for_progress, move |progress| {
            let _ = app_clone.emit(
                "model-download-progress",
                serde_json::json!({ "progress": progress, "model": &model_name_ref }),
            );
        })
    })
    .await
    .map_err(|e| format!("ダウンロードタスクの実行に失敗しました: {e}"))??;

    Ok(result.to_string_lossy().to_string())
}

/// 文字起こしを開始する
///
/// `source` パラメータ:
/// - `Some("microphone")`: マイクのみ
/// - `Some("system_audio")`: システム音声のみ
/// - `None` または `Some("both")`: 両方（デュアルストリーム）
#[tauri::command]
pub fn start_transcription(
    model_name: String,
    source: Option<String>,
    audio_state: tauri::State<'_, crate::audio::AudioStateHandle>,
    transcription_state: tauri::State<'_, TranscriptionStateHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut manager = transcription_state.0.lock();

    if manager.is_running() {
        return Err("文字起こしは既に実行中です".to_string());
    }

    // モデルを読み込む（まだの場合）
    if !manager.is_engine_loaded() {
        manager.load_model(&model_name)?;
    }

    // エンジンの Arc クローンを取得（所有権を移動せずスレッドに渡す）
    let engine = Arc::clone(
        manager
            .engine
            .as_ref()
            .ok_or_else(|| "文字起こしエンジンが初期化されていません".to_string())?,
    );

    let running = manager.running_flag();
    running.store(true, Ordering::SeqCst);

    let source_str = source.as_deref().unwrap_or("both");

    let use_mic = source_str == "microphone" || source_str == "both";
    let use_system = source_str == "system_audio" || source_str == "both";

    let mut spawned_any = false;

    // マイク用の文字起こしスレッド
    if use_mic {
        if let Some(mic_sample_rate) = audio_state.get_sample_rate() {
            if let Some(mic_consumer) = audio_state.take_consumer() {
                let engine_clone = Arc::clone(&engine);
                let running_clone = Arc::clone(&running);
                let app_clone = app.clone();
                let speaker = Some("自分".to_string());

                std::thread::spawn(move || {
                    run_transcription_loop(
                        mic_consumer,
                        engine_clone,
                        mic_sample_rate,
                        running_clone,
                        app_clone,
                        speaker,
                    );
                });
                spawned_any = true;
            }
        }
    }

    // システム音声用の文字起こしスレッド
    if use_system {
        if let Some(sys_sample_rate) = audio_state.get_system_audio_sample_rate() {
            if let Some(sys_consumer) = audio_state.take_system_audio_consumer() {
                let engine_clone = Arc::clone(&engine);
                let running_clone = Arc::clone(&running);
                let app_clone = app.clone();
                let speaker = Some("相手".to_string());

                std::thread::spawn(move || {
                    run_transcription_loop(
                        sys_consumer,
                        engine_clone,
                        sys_sample_rate,
                        running_clone,
                        app_clone,
                        speaker,
                    );
                });
                spawned_any = true;
            }
        }
    }

    if !spawned_any {
        running.store(false, Ordering::SeqCst);
        return Err("音声ソースが利用可能ではありません。録音を先に開始してください。".to_string());
    }

    Ok(())
}

/// 文字起こしを停止する
#[tauri::command]
pub fn stop_transcription(
    state: tauri::State<'_, TranscriptionStateHandle>,
) -> Result<(), String> {
    let mut manager = state.0.lock();
    if !manager.is_running() {
        return Err("文字起こしは実行されていません".to_string());
    }
    manager.stop();
    Ok(())
}

// ─────────────────────────────────────────────
// リサンプリング
// ─────────────────────────────────────────────

/// Whisper の入力サンプルレート（16kHz）
const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// リサンプリング用の共通パラメータを返す
fn sinc_params() -> SincInterpolationParameters {
    SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    }
}

/// リサンプラーのチャンクサイズ（入力フレーム数）
const RESAMPLE_CHUNK_SIZE: usize = 1024;

/// オーディオサンプルを source_rate から target_rate にリサンプルする。
///
/// rubato の SincFixedIn を使用した高品質なリサンプリングを行う。
/// source_rate == target_rate の場合はコピーを返し、空入力には空出力を返す。
#[allow(dead_code)]
pub fn resample_audio(
    samples: &[f32],
    source_rate: u32,
    target_rate: u32,
) -> Result<Vec<f32>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    if source_rate == target_rate {
        return Ok(samples.to_vec());
    }

    let mut resampler = SincFixedIn::<f32>::new(
        target_rate as f64 / source_rate as f64,
        2.0,
        sinc_params(),
        RESAMPLE_CHUNK_SIZE,
        1, // モノラル
    )
    .map_err(|e| format!("リサンプラーの作成に失敗しました: {e}"))?;

    let mut output = Vec::new();
    let mut pos = 0;

    loop {
        let frames_needed = resampler.input_frames_next();
        if pos >= samples.len() {
            break;
        }

        let end = (pos + frames_needed).min(samples.len());
        let mut input_chunk: Vec<f32> = samples[pos..end].to_vec();
        let was_padded = input_chunk.len() < frames_needed;

        // 最後のチャンクがフレーム数に満たない場合はゼロパディング
        if was_padded {
            input_chunk.resize(frames_needed, 0.0);
        }

        let input_refs: Vec<&[f32]> = vec![&input_chunk];
        match resampler.process(&input_refs, None) {
            Ok(result) => {
                if let Some(channel) = result.first() {
                    output.extend_from_slice(channel);
                }
            }
            Err(e) => return Err(format!("リサンプリングエラー: {e}")),
        }

        pos = end;

        // ゼロパディングした場合は最後のチャンクなのでループ終了
        if was_padded {
            break;
        }
    }

    // 入力長に基づいた期待出力長でトリミング
    let expected_len =
        (samples.len() as f64 * target_rate as f64 / source_rate as f64).round() as usize;
    output.truncate(expected_len);

    Ok(output)
}

// ─────────────────────────────────────────────
// 文字起こしループ
// ─────────────────────────────────────────────

/// チャンクの蓄積目標（秒）
const CHUNK_DURATION_SECS: f64 = 5.0;

/// 16kHz での5秒分のサンプル数
const CHUNK_SAMPLES: usize = (WHISPER_SAMPLE_RATE as f64 * CHUNK_DURATION_SECS) as usize; // 80,000

fn run_transcription_loop(
    mut consumer: ringbuf::HeapCons<f32>,
    engine: Arc<dyn TranscriptionEngine>,
    device_sample_rate: u32,
    running: Arc<AtomicBool>,
    app: tauri::AppHandle,
    speaker: Option<String>,
) {
    // リサンプラーの設定（device_sample_rate → 16kHz）
    let needs_resample = device_sample_rate != WHISPER_SAMPLE_RATE;
    let mut resampler = if needs_resample {
        match SincFixedIn::<f32>::new(
            WHISPER_SAMPLE_RATE as f64 / device_sample_rate as f64,
            2.0,
            sinc_params(),
            RESAMPLE_CHUNK_SIZE,
            1, // チャンネル数（モノラル）
        ) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("リサンプラーの作成に失敗しました: {e}");
                let _ = app.emit(
                    "transcription-error",
                    serde_json::json!({ "error": format!("リサンプラーの作成に失敗しました: {e}") }),
                );
                return;
            }
        }
    } else {
        None
    };

    let mut accumulation_buffer: Vec<f32> = Vec::with_capacity(CHUNK_SAMPLES);
    let mut read_buffer: Vec<f32> = vec![0.0; 4096];
    let mut resample_input_buffer: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK_SIZE);
    let mut chunk_count: u64 = 0;

    while running.load(Ordering::SeqCst) {
        // 1. リングバッファからサンプルを読み取る
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

        // 2. リサンプリング（必要な場合）
        if let Some(ref mut resampler) = resampler {
            resample_input_buffer.extend_from_slice(samples);

            // リサンプラーのチャンクサイズ分たまったら処理
            let chunk_size = resampler.input_frames_next();
            while resample_input_buffer.len() >= chunk_size {
                let input_chunk: Vec<f32> =
                    resample_input_buffer.drain(..chunk_size).collect();
                let input_refs: Vec<&[f32]> = vec![&input_chunk];

                match resampler.process(&input_refs, None) {
                    Ok(output) => {
                        if let Some(channel) = output.first() {
                            accumulation_buffer.extend_from_slice(channel);
                        }
                    }
                    Err(e) => {
                        eprintln!("リサンプリングエラー: {e}");
                    }
                }
            }
        } else {
            // リサンプリング不要（既に16kHz）
            accumulation_buffer.extend_from_slice(samples);
        }

        // 3. チャンクが十分に蓄積されたら推論を実行
        if accumulation_buffer.len() >= CHUNK_SAMPLES {
            let chunk: Vec<f32> = accumulation_buffer.drain(..CHUNK_SAMPLES).collect();
            chunk_count += 1;

            match engine.transcribe(&chunk) {
                Ok(segments) => {
                    for segment in segments {
                        if !segment.text.is_empty() {
                            // タイムスタンプをグローバルオフセットに調整
                            let offset_ms =
                                (chunk_count - 1) as i64 * (CHUNK_DURATION_SECS * 1000.0) as i64;
                            let adjusted = TranscriptionSegment {
                                text: segment.text,
                                start_ms: segment.start_ms + offset_ms,
                                end_ms: segment.end_ms + offset_ms,
                                speaker: speaker.clone(),
                            };
                            let _ = app.emit("transcription-result", &adjusted);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("文字起こしエラー: {e}");
                    let _ = app.emit(
                        "transcription-error",
                        serde_json::json!({ "error": e }),
                    );
                }
            }
        }

        // 4. ビジーウェイトを回避
        std::thread::sleep(Duration::from_millis(50));
    }

    // ループ終了 - consumer はここでドロップされる
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_available_models_not_empty() {
        let models = ModelManager::list_available_models();
        assert!(!models.is_empty());
    }

    #[test]
    fn test_list_available_models_includes_small() {
        let models = ModelManager::list_available_models();
        assert!(models.iter().any(|m| m.name == "small"));
    }

    #[test]
    fn test_model_manager_get_path() {
        let manager = ModelManager::new();
        let path = manager.get_model_path("small");
        assert!(path.to_str().unwrap().contains("ggml-small.bin"));
    }

    #[test]
    fn test_model_not_downloaded_initially() {
        // ダウンロードしていないモデルは false を返すべき
        // 実際のダウンロードディレクトリを参照しないようにユニークな一時ディレクトリを使用
        let manager =
            ModelManager::with_dir(std::env::temp_dir().join("meet-jerky-test-models"));
        assert!(!manager.is_model_downloaded("small"));
    }

    #[test]
    fn test_transcription_segment_serialization() {
        // speaker: None の場合、JSONに speaker フィールドが含まれないことを確認
        let segment = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            speaker: None,
        };
        let json = serde_json::to_string(&segment).unwrap();
        assert!(json.contains("startMs"));
        assert!(json.contains("endMs"));
        assert!(!json.contains("start_ms"));
        assert!(!json.contains("speaker"), "speaker: None should be skipped in JSON");

        // speaker: Some("自分") の場合、JSONに speaker フィールドが含まれることを確認
        let segment_with_speaker = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            speaker: Some("自分".to_string()),
        };
        let json_with_speaker = serde_json::to_string(&segment_with_speaker).unwrap();
        assert!(json_with_speaker.contains("\"speaker\":\"自分\""), "speaker: Some(\"自分\") should appear in JSON");
    }

    // ─────────────────────────────────────────
    // resample_audio テスト
    // ─────────────────────────────────────────

    #[test]
    fn test_resample_same_rate() {
        // 16kHz -> 16kHz: 同一レートではそのままコピーが返る
        let input: Vec<f32> = (0..1600).map(|i| (i as f32 / 1600.0).sin()).collect();
        let output = resample_audio(&input, 16000, 16000).unwrap();
        assert_eq!(output.len(), input.len());
        assert_eq!(output, input);
    }

    #[test]
    fn test_resample_downsample_length() {
        // 48kHz -> 16kHz: サンプル数がおよそ 1/3 になる
        let input: Vec<f32> = vec![0.0; 48000]; // 1秒分 @ 48kHz
        let output = resample_audio(&input, 48000, 16000).unwrap();
        // リサンプラーのエッジ効果を許容
        assert!(
            (output.len() as f32 - 16000.0).abs() < 200.0,
            "Expected ~16000 samples, got {}",
            output.len()
        );
    }

    #[test]
    fn test_resample_empty_input() {
        let output = resample_audio(&[], 48000, 16000).unwrap();
        assert!(output.is_empty());
    }

    #[test]
    fn test_resample_preserves_silence() {
        // 無音入力は無音出力になるべき
        let input: Vec<f32> = vec![0.0; 4800];
        let output = resample_audio(&input, 48000, 16000).unwrap();
        assert!(
            output.iter().all(|&s| s.abs() < 0.001),
            "Silent input should produce silent output, max abs value: {}",
            output.iter().map(|s| s.abs()).fold(0.0f32, f32::max)
        );
    }
}
