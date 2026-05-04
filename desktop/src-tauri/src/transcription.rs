use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use ringbuf::traits::{Consumer, Observer};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use tauri::Emitter;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::audio_utils::is_tail_silent;

// ─────────────────────────────────────────────
// データ型 (transcription_types.rs に分離、ここから互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_types::{
    ModelInfo, TranscriptionErrorPayload, TranscriptionSegment, TranscriptionSource,
};

// ─────────────────────────────────────────────
// TranscriptionEngine / TranscriptionStream トレイト (transcription_traits.rs に分離、互換層として再エクスポート)
// ─────────────────────────────────────────────

pub use crate::transcription_traits::{StreamConfig, TranscriptionEngine, TranscriptionStream};

// ─────────────────────────────────────────────
// WhisperLocal 実装
// ─────────────────────────────────────────────

pub struct WhisperLocal {
    ctx: Arc<WhisperContext>,
}

impl WhisperLocal {
    pub fn new(model_path: &str) -> Result<Self, String> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| format!("Whisper モデルの読み込みに失敗しました: {e}"))?;
        Ok(Self { ctx: Arc::new(ctx) })
    }

    /// 1 チャンク (16kHz, モノラル) を Whisper で推論する。
    fn transcribe_chunk(
        ctx: &WhisperContext,
        audio: &[f32],
        language: &str,
    ) -> Result<Vec<TranscriptionSegment>, String> {
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("WhisperState の作成に失敗しました: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
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
        let mut segments = Vec::with_capacity(num_segments as usize);

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
                source: None,
                speaker: None,
                is_error: None,
            });
        }

        Ok(segments)
    }
}

impl TranscriptionEngine for WhisperLocal {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String> {
        let stream = WhisperStream::new(Arc::clone(&self.ctx), config)?;
        Ok(Box::new(stream))
    }
}

// ─────────────────────────────────────────────
// WhisperStream — Whisper 用ストリーミング実装
// ─────────────────────────────────────────────

/// Whisper 用のストリーミング実装。
///
/// 内部で次の処理を行う:
/// - 入力サンプルを 16kHz にリサンプル
/// - 5 秒分たまったら推論を実行
/// - 結果セグメントにストリーム基準のグローバルオフセットを付与
///
/// `drain_segments` は確定済みセグメントを取り出す。
pub struct WhisperStream {
    #[cfg(not(test))]
    ctx: Arc<WhisperContext>,
    #[cfg(test)]
    ctx: Option<Arc<WhisperContext>>,
    speaker: Option<String>,
    source: Option<TranscriptionSource>,
    language: String,
    needs_resample: bool,
    resampler: Option<SincFixedIn<f32>>,
    resample_input_buffer: Vec<f32>,
    accumulation_buffer: Vec<f32>,
    pending_segments: Vec<TranscriptionSegment>,
    chunk_count: u64,
}

impl WhisperStream {
    fn new(ctx: Arc<WhisperContext>, config: StreamConfig) -> Result<Self, String> {
        let needs_resample = config.sample_rate != WHISPER_SAMPLE_RATE;
        let resampler = if needs_resample {
            Some(
                SincFixedIn::<f32>::new(
                    WHISPER_SAMPLE_RATE as f64 / config.sample_rate as f64,
                    2.0,
                    sinc_params(),
                    RESAMPLE_CHUNK_SIZE,
                    1, // モノラル
                )
                .map_err(|e| format!("リサンプラーの作成に失敗しました: {e}"))?,
            )
        } else {
            None
        };

        let language = config.language.unwrap_or_else(|| "auto".to_string());

        Ok(Self {
            #[cfg(not(test))]
            ctx,
            #[cfg(test)]
            ctx: Some(ctx),
            speaker: config.speaker,
            source: config.source,
            language,
            needs_resample,
            resampler,
            resample_input_buffer: Vec::with_capacity(RESAMPLE_CHUNK_SIZE * 2),
            accumulation_buffer: Vec::with_capacity(CHUNK_SAMPLES * 2),
            pending_segments: Vec::new(),
            chunk_count: 0,
        })
    }

    /// 5 秒チャンクが溜まっていれば推論し、`pending_segments` に積む。
    /// 5 秒未満でも最小チャンク長以上かつ末尾が沈黙の場合は早期 flush する。
    fn flush_full_chunks(&mut self) -> Result<(), String> {
        // (a) 5 秒以上たまったら従来通り 5 秒で flush (現状維持、回帰なし)
        while self.accumulation_buffer.len() >= CHUNK_SAMPLES {
            let chunk: Vec<f32> = self.accumulation_buffer.drain(..CHUNK_SAMPLES).collect();
            self.run_inference(&chunk)?;
        }
        // (b) 5 秒未満でも、最小チャンク長以上 + 末尾が沈黙なら早期 flush
        if self.accumulation_buffer.len() >= MIN_FLUSH_SAMPLES
            && is_tail_silent(
                &self.accumulation_buffer,
                SILENCE_LOOKBACK_SAMPLES,
                SILENCE_THRESHOLD_RMS,
            )
        {
            let chunk: Vec<f32> = std::mem::take(&mut self.accumulation_buffer);
            self.run_inference(&chunk)?;
        }
        Ok(())
    }

    fn run_inference(&mut self, chunk: &[f32]) -> Result<(), String> {
        self.chunk_count += 1;
        #[cfg(not(test))]
        let segments = WhisperLocal::transcribe_chunk(&self.ctx, chunk, &self.language)?;
        #[cfg(test)]
        let segments = {
            let ctx = self.ctx.as_ref().ok_or_else(|| {
                "WhisperContext がテストストリームに設定されていません".to_string()
            })?;
            WhisperLocal::transcribe_chunk(ctx, chunk, &self.language)?
        };
        let offset_ms = (self.chunk_count - 1) as i64 * (CHUNK_DURATION_SECS * 1000.0) as i64;
        for seg in segments {
            if seg.text.is_empty() {
                continue;
            }
            self.pending_segments.push(TranscriptionSegment {
                text: seg.text,
                start_ms: seg.start_ms + offset_ms,
                end_ms: seg.end_ms + offset_ms,
                source: self.source,
                speaker: self.speaker.clone(),
                is_error: None,
            });
        }
        Ok(())
    }
}

impl TranscriptionStream for WhisperStream {
    fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }

        if self.needs_resample {
            self.resample_input_buffer.extend_from_slice(samples);

            // resampler は所有権を一時的に取り出して借用問題を回避する
            let mut resampler = self.resampler.take().ok_or_else(|| {
                "リサンプラー状態が利用できません: リサンプリングが必要ですが内部状態がありません"
                    .to_string()
            })?;
            let result = (|| -> Result<(), String> {
                let chunk_size = resampler.input_frames_next();
                while self.resample_input_buffer.len() >= chunk_size {
                    let input_chunk: Vec<f32> =
                        self.resample_input_buffer.drain(..chunk_size).collect();
                    let input_refs: Vec<&[f32]> = vec![&input_chunk];
                    match resampler.process(&input_refs, None) {
                        Ok(output) => {
                            if let Some(channel) = output.first() {
                                self.accumulation_buffer.extend_from_slice(channel);
                            }
                        }
                        Err(e) => return Err(format!("リサンプリングエラー: {e}")),
                    }
                }
                Ok(())
            })();
            self.resampler = Some(resampler);
            result?;
        } else {
            self.accumulation_buffer.extend_from_slice(samples);
        }

        self.flush_full_chunks()
    }

    fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
        std::mem::take(&mut self.pending_segments)
    }

    fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
        // 残ったリサンプリング入力はゼロパディングして処理し切る
        if self.needs_resample && !self.resample_input_buffer.is_empty() {
            let mut resampler = self.resampler.take().ok_or_else(|| {
                "リサンプラー状態が利用できません: リサンプリングが必要ですが内部状態がありません"
                    .to_string()
            })?;
            let chunk_size = resampler.input_frames_next();
            let mut input_chunk = std::mem::take(&mut self.resample_input_buffer);
            input_chunk.resize(chunk_size, 0.0);
            let input_refs: Vec<&[f32]> = vec![&input_chunk];
            match resampler.process(&input_refs, None) {
                Ok(output) => {
                    if let Some(channel) = output.first() {
                        self.accumulation_buffer.extend_from_slice(channel);
                    }
                }
                Err(e) => return Err(format!("リサンプリングエラー: {e}")),
            }
        }

        // 5 秒未満の最終チャンクも推論する
        if !self.accumulation_buffer.is_empty() {
            let chunk = std::mem::take(&mut self.accumulation_buffer);
            self.run_inference(&chunk)?;
        }

        Ok(std::mem::take(&mut self.pending_segments))
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
    /// 現在ロード中のエンジン種別と、Whisper の場合のモデル名。
    /// 同じ条件での再 ensure_engine 呼び出しでは再初期化をスキップする。
    loaded_engine_signature: Option<(crate::settings::TranscriptionEngineType, String)>,
    running: Arc<AtomicBool>,
    model_manager: ModelManager,
}

impl TranscriptionManager {
    pub fn new() -> Self {
        Self {
            engine: None,
            loaded_engine_signature: None,
            running: Arc::new(AtomicBool::new(false)),
            model_manager: ModelManager::new(),
        }
    }

    /// エンジンが読み込まれているか (テスト用 / 内部診断用)
    #[cfg(test)]
    pub fn is_engine_loaded(&self) -> bool {
        self.engine.is_some()
    }

    /// 文字起こしが実行中か
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Whisper モデルを読み込む（まだ読み込まれていない場合）
    pub fn load_model(&mut self, model_name: &str) -> Result<(), String> {
        let model_path = self.model_manager.get_model_path(model_name);
        if !model_path.exists() {
            return Err(format!("モデルがダウンロードされていません: {model_name}"));
        }

        let path_str = model_path
            .to_str()
            .ok_or_else(|| "モデルパスの変換に失敗しました".to_string())?;
        let engine = WhisperLocal::new(path_str)?;
        self.engine = Some(Arc::new(engine));
        Ok(())
    }

    /// 設定で選択されたエンジンに切り替える。
    ///
    /// 同じエンジン種別 (Whisper の場合は同じモデル名) が既に読み込まれていれば
    /// 何もしない。条件が変わった場合は古いエンジンを破棄して新しいエンジンを
    /// 初期化する。
    ///
    /// `whisper_model` は Whisper を選んだ時のみ参照される。
    pub fn ensure_engine(
        &mut self,
        engine_type: &crate::settings::TranscriptionEngineType,
        whisper_model: &str,
    ) -> Result<(), String> {
        use crate::settings::TranscriptionEngineType;

        // 既にロード済みなら早期 return。Whisper は model 名一致が条件、
        // それ以外は engine 種別一致のみで判定。
        let signature = (engine_type.clone(), whisper_model.to_string());
        if self.engine.is_some() && self.loaded_engine_signature.as_ref() == Some(&signature) {
            return Ok(());
        }

        match engine_type {
            TranscriptionEngineType::Whisper => {
                self.load_model(whisper_model)?;
            }
            TranscriptionEngineType::AppleSpeech => {
                let engine = crate::apple_speech::AppleSpeechEngine::new()?;
                self.engine = Some(Arc::new(engine));
            }
            TranscriptionEngineType::OpenAIRealtime => {
                // モデル名は今のところ固定値 (将来的には設定で切り替え可能にする)。
                // gpt-4o-mini-transcribe は安価でレイテンシが低い。
                let engine =
                    crate::openai_realtime::OpenAIRealtimeEngine::new("gpt-4o-mini-transcribe");
                self.engine = Some(Arc::new(engine));
            }
            TranscriptionEngineType::ElevenLabsRealtime => {
                let engine = crate::elevenlabs_realtime::ElevenLabsRealtimeEngine::new(
                    crate::elevenlabs_realtime::SCRIBE_V2_REALTIME_MODEL_ID,
                );
                self.engine = Some(Arc::new(engine));
            }
        }

        self.loaded_engine_signature = Some(signature);
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

/// `model-download-progress` イベントの payload を組み立てる（純粋関数）
fn build_download_progress_payload(progress: f64, model: &str) -> serde_json::Value {
    serde_json::json!({ "progress": progress, "model": model })
}

/// `model-download-error` イベントの payload を組み立てる（純粋関数）
fn build_download_error_payload(model: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "model": model, "message": message })
}

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
///
/// 失敗時は Result で Err を返すことに加え、`model-download-error` を emit する。
/// 既存の `invoke` catch 経路に加えて listen 側でも統一的にハンドリングできるようにする。
#[tauri::command]
pub async fn download_model(model_name: String, app: tauri::AppHandle) -> Result<String, String> {
    let model_name_for_progress = model_name.clone();
    let app_for_progress = app.clone();

    // ダウンロードはブロッキングI/Oなので専用スレッドで実行
    let join_result = tokio::task::spawn_blocking(move || {
        let manager = ModelManager::new();
        let model_name_ref = model_name_for_progress.clone();
        manager.download_model(&model_name_for_progress, move |progress| {
            let _ = app_for_progress.emit(
                "model-download-progress",
                build_download_progress_payload(progress, &model_name_ref),
            );
        })
    })
    .await
    .map_err(|e| format!("ダウンロードタスクの実行に失敗しました: {e}"));

    match join_result {
        Ok(Ok(path)) => Ok(path.to_string_lossy().to_string()),
        Ok(Err(msg)) => {
            let _ = app.emit(
                "model-download-error",
                build_download_error_payload(&model_name, &msg),
            );
            Err(msg)
        }
        Err(msg) => {
            let _ = app.emit(
                "model-download-error",
                build_download_error_payload(&model_name, &msg),
            );
            Err(msg)
        }
    }
}

fn validate_stream_count_for_engine(
    engine_type: &crate::settings::TranscriptionEngineType,
    stream_count: usize,
) -> Result<(), String> {
    if matches!(
        engine_type,
        crate::settings::TranscriptionEngineType::AppleSpeech
    ) && stream_count > 1
    {
        return Err(
            "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。"
                .to_string(),
        );
    }
    Ok(())
}

/// 文字起こしを開始する
///
/// `source` パラメータ:
/// - `Some("microphone")`: マイクのみ
/// - `Some("system_audio")`: システム音声のみ
/// - `None` または `Some("both")`: 両方（デュアルストリーム）
///
/// `model_name` は Whisper を選択した時のみ使われる。Apple SpeechAnalyzer 等
/// 別エンジンを選んだ場合は無視される (引数互換のため残している)。
#[tauri::command]
pub fn start_transcription(
    model_name: String,
    source: Option<String>,
    audio_state: tauri::State<'_, crate::audio::AudioStateHandle>,
    transcription_state: tauri::State<'_, TranscriptionStateHandle>,
    settings_state: tauri::State<'_, crate::settings::SettingsStateHandle>,
    session_manager: tauri::State<'_, Arc<crate::session_manager::SessionManager>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut manager = transcription_state.0.lock();

    if manager.is_running() {
        return Err("文字起こしは既に実行中です".to_string());
    }

    // 設定からエンジン種別を読み取り、必要ならエンジンを切り替える。
    // 引数の `model_name` は Whisper の場合に優先採用 (UI から選択された値を反映)。
    let (engine_type, whisper_model, language) = {
        let settings = settings_state.0.lock();
        let model = if model_name.is_empty() {
            settings.whisper_model.clone()
        } else {
            model_name.clone()
        };
        (
            settings.transcription_engine.clone(),
            model,
            settings.language.clone(),
        )
    };

    manager.ensure_engine(&engine_type, &whisper_model)?;

    // エンジンの Arc クローンを取得（所有権を移動せずスレッドに渡す）
    let engine = Arc::clone(
        manager
            .engine
            .as_ref()
            .ok_or_else(|| "文字起こしエンジンが初期化されていません".to_string())?,
    );

    let running = manager.running_flag();

    let requested_sources = parse_requested_transcription_sources(source.as_deref())?;
    let stream_language = Some(language.trim().to_string()).filter(|value| !value.is_empty());

    let mic_sample_rate = if requested_sources.use_mic {
        audio_state.get_sample_rate()
    } else {
        None
    };
    let system_sample_rate = if requested_sources.use_system {
        audio_state.get_system_audio_sample_rate()
    } else {
        None
    };
    let available_stream_count = [mic_sample_rate, system_sample_rate]
        .into_iter()
        .filter(Option::is_some)
        .count();
    validate_stream_count_for_engine(&engine_type, available_stream_count)?;

    let mut pending_streams = Vec::new();

    // live loop に渡す SessionManager の Arc と、ストリーム基準時刻 (now)。
    // stream_started_at_secs はマイク/システム両 worker で共通の基準として用い、
    // セグメントの絶対時刻 (= offset 算出の起点) を決定する。
    let session_manager_arc: Arc<crate::session_manager::SessionManager> =
        Arc::clone(session_manager.inner());
    let stream_started_at_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // マイク用の文字起こしスレッド
    if let Some(mic_sample_rate) = mic_sample_rate {
        let stream_config = StreamConfig {
            sample_rate: mic_sample_rate,
            speaker: Some("自分".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: stream_language.clone(),
        };
        let stream = Arc::clone(&engine)
            .start_stream(stream_config)
            .map_err(|e| format!("マイク音声の文字起こしストリーム初期化に失敗しました: {e}"))?;

        pending_streams.push(PendingTranscriptionStream {
            source: TranscriptionSource::Microphone,
            stream,
        });
    }

    // システム音声用の文字起こしスレッド
    if let Some(sys_sample_rate) = system_sample_rate {
        let stream_config = StreamConfig {
            sample_rate: sys_sample_rate,
            speaker: Some("相手側".to_string()),
            source: Some(TranscriptionSource::SystemAudio),
            language: stream_language.clone(),
        };
        let stream = Arc::clone(&engine)
            .start_stream(stream_config)
            .map_err(|e| format!("システム音声の文字起こしストリーム初期化に失敗しました: {e}"))?;

        pending_streams.push(PendingTranscriptionStream {
            source: TranscriptionSource::SystemAudio,
            stream,
        });
    }

    let mut workers = Vec::new();
    for pending in pending_streams {
        let consumer = match pending.source {
            TranscriptionSource::Microphone => audio_state.take_consumer(),
            TranscriptionSource::SystemAudio => audio_state.take_system_audio_consumer(),
        };

        if let Some(consumer) = consumer {
            workers.push(TranscriptionLoopConfig {
                consumer,
                source: pending.source,
                stream: pending.stream,
                running: Arc::clone(&running),
                app: app.clone(),
                session_manager: Arc::clone(&session_manager_arc),
                stream_started_at_secs,
            });
        }
    }

    if workers.is_empty() {
        return Err("音声ソースが利用可能ではありません。録音を先に開始してください。".to_string());
    }

    running.store(true, Ordering::SeqCst);

    for worker in workers {
        std::thread::spawn(move || {
            run_transcription_worker_with_panic_guard(worker);
        });
    }

    Ok(())
}

/// 文字起こしを停止する
#[tauri::command]
pub fn stop_transcription(state: tauri::State<'_, TranscriptionStateHandle>) -> Result<(), String> {
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

/// 早期 flush を許可する最小チャンク長 (1 秒 @ 16kHz)。これ未満では Whisper の精度が落ちるため flush しない。
const MIN_FLUSH_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize; // 16000

/// 末尾の沈黙判定に使うウィンドウ長 (0.5 秒 @ 16kHz)。
const SILENCE_LOOKBACK_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize / 2; // 8000

/// 沈黙とみなす RMS 閾値 (-40dBFS 相当 ≈ 0.01)。実機の背景ノイズで再調整が必要。
/// 調査担当推奨の -60dBFS (= 0.001) は会議室背景ノイズより低く誤判定リスクが大きいため、より安全側を選択。
const SILENCE_THRESHOLD_RMS: f32 = 0.01;

struct PendingTranscriptionStream {
    source: TranscriptionSource,
    stream: Box<dyn TranscriptionStream>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RequestedTranscriptionSources {
    use_mic: bool,
    use_system: bool,
}

const TRANSCRIPTION_SOURCE_MICROPHONE: &str = "microphone";
const TRANSCRIPTION_SOURCE_SYSTEM_AUDIO: &str = "system_audio";

fn parse_requested_transcription_sources(
    source: Option<&str>,
) -> Result<RequestedTranscriptionSources, String> {
    let source = source.unwrap_or("both").trim();
    match source {
        TRANSCRIPTION_SOURCE_MICROPHONE => Ok(RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        }),
        TRANSCRIPTION_SOURCE_SYSTEM_AUDIO => Ok(RequestedTranscriptionSources {
            use_mic: false,
            use_system: true,
        }),
        "both" => Ok(RequestedTranscriptionSources {
            use_mic: true,
            use_system: true,
        }),
        _ => Err(
            "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。"
                .to_string(),
        ),
    }
}

struct TranscriptionLoopConfig {
    consumer: ringbuf::HeapCons<f32>,
    source: TranscriptionSource,
    stream: Box<dyn TranscriptionStream>,
    running: Arc<AtomicBool>,
    app: tauri::AppHandle,
    session_manager: Arc<crate::session_manager::SessionManager>,
    stream_started_at_secs: u64,
}

fn build_transcription_error_payload(
    error: String,
    source: Option<TranscriptionSource>,
) -> TranscriptionErrorPayload {
    TranscriptionErrorPayload { error, source }
}

fn build_worker_panic_error_payload(
    source: Option<TranscriptionSource>,
) -> TranscriptionErrorPayload {
    build_transcription_error_payload("文字起こしワーカーが異常終了しました".to_string(), source)
}

#[cfg(test)]
fn transcription_error_payload_to_value(payload: &TranscriptionErrorPayload) -> serde_json::Value {
    serde_json::to_value(payload).expect("transcription error payload should serialize to JSON")
}

fn is_realtime_stream_already_stopped_error(error: &str) -> bool {
    error.contains("Realtime ストリームが既に停止しています")
}

fn should_emit_realtime_stream_error(error: &str) -> bool {
    !is_realtime_stream_already_stopped_error(error)
}

fn run_transcription_worker_with_panic_guard(worker: TranscriptionLoopConfig) {
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

fn run_transcription_loop(cfg: TranscriptionLoopConfig) {
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

/// セグメントを Tauri イベントとして emit し、セッションが開始済みであれば
/// `SessionManager` にも append する。
fn emit_segments(
    segments: Vec<TranscriptionSegment>,
    app: &tauri::AppHandle,
    session_manager: &Arc<crate::session_manager::SessionManager>,
    stream_started_at_secs: u64,
) {
    for segment in segments {
        if segment.text.is_empty() {
            continue;
        }
        let _ = app.emit("transcription-result", &segment);

        let session_started_at_secs = session_manager.current_started_at_secs();
        let observed_at_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs());
        if let Some((sp, off, tx)) = crate::transcript_bridge::build_append_args_for_emission_at(
            &segment,
            session_started_at_secs,
            stream_started_at_secs,
            observed_at_secs,
        ) {
            if let Err(e) = session_manager.append(sp, off, tx) {
                eprintln!("[transcription] session_manager.append failed: {e}");
            }
        }
    }
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_utils::calculate_rms;

    fn stream_with_missing_resampler(resample_input_buffer: Vec<f32>) -> WhisperStream {
        WhisperStream {
            ctx: None,
            speaker: None,
            source: None,
            language: "ja".to_string(),
            needs_resample: true,
            resampler: None,
            resample_input_buffer,
            accumulation_buffer: Vec::new(),
            pending_segments: Vec::new(),
            chunk_count: 0,
        }
    }

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
        let manager = ModelManager::with_dir(std::env::temp_dir().join("meet-jerky-test-models"));
        assert!(!manager.is_model_downloaded("small"));
    }

    #[test]
    fn test_download_progress_payload_serialization() {
        // 既存 progress イベントの payload 形を固定化（回帰防止）。
        // 型側 DownloadProgressPayload { progress, model } と噛み合う形を保証する。
        let payload = build_download_progress_payload(0.5, "small");
        let s = payload.to_string();
        assert!(s.contains("\"progress\":0.5"), "got: {s}");
        assert!(s.contains("\"model\":\"small\""), "got: {s}");
    }

    #[test]
    fn test_download_error_payload_serialization() {
        // model-download-error の payload は { model, message } のフラットキー。
        // TypeScript 側 DownloadErrorPayload と噛み合う形を保証する。
        let payload = build_download_error_payload("small", "HTTP 404");
        let s = payload.to_string();
        assert!(s.contains("\"model\":\"small\""), "got: {s}");
        assert!(s.contains("\"message\":\"HTTP 404\""), "got: {s}");
    }

    #[test]
    fn test_worker_panic_payload_does_not_expose_panic_details() {
        let payload = build_worker_panic_error_payload(Some(TranscriptionSource::Microphone));
        let payload = transcription_error_payload_to_value(&payload);
        assert_eq!(
            payload.get("error").and_then(|value| value.as_str()),
            Some("文字起こしワーカーが異常終了しました")
        );
        assert_eq!(
            payload.get("source").and_then(|value| value.as_str()),
            Some("microphone")
        );
        let serialized = payload.to_string();
        assert!(!serialized.contains("panic"));
        assert!(!serialized.contains("payload"));
    }

    #[test]
    fn test_transcription_error_payload_serialization_with_source() {
        let payload = build_transcription_error_payload(
            "入力音声の処理に失敗しました".to_string(),
            Some(TranscriptionSource::SystemAudio),
        );

        assert_eq!(
            transcription_error_payload_to_value(&payload),
            serde_json::json!({
                "error": "入力音声の処理に失敗しました",
                "source": "system_audio",
            })
        );
    }

    #[test]
    fn test_transcription_error_payload_serialization_omits_missing_source() {
        let payload = build_transcription_error_payload("初期化に失敗しました".to_string(), None);

        assert_eq!(
            transcription_error_payload_to_value(&payload),
            serde_json::json!({
                "error": "初期化に失敗しました",
            })
        );
    }

    #[test]
    fn transcription_source_constants_are_snake_case_lowercase() {
        assert_eq!(TRANSCRIPTION_SOURCE_MICROPHONE, "microphone");
        assert_eq!(TRANSCRIPTION_SOURCE_SYSTEM_AUDIO, "system_audio");
    }

    #[test]
    fn test_parse_requested_transcription_sources_accepts_known_values() {
        assert_eq!(
            parse_requested_transcription_sources(None).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" both ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some("microphone")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some("system_audio")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: false,
                use_system: true,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" microphone ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            }
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" system_audio ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: false,
                use_system: true,
            }
        );
    }

    #[test]
    fn test_parse_requested_transcription_sources_rejects_unknown_values() {
        for source in ["", " ", "mic", "system", "both,microphone"] {
            let error = parse_requested_transcription_sources(Some(source))
                .expect_err("unknown source should be rejected");
            assert!(
                error.contains("文字起こしソースが不正です"),
                "unexpected error for {source:?}: {error}"
            );
            assert!(
                error.contains("microphone")
                    && error.contains("system_audio")
                    && error.contains("both"),
                "error should list accepted source values: {error}"
            );
        }
    }

    #[test]
    fn test_stopped_realtime_stream_errors_are_not_emitted_to_ui() {
        assert!(!should_emit_realtime_stream_error(
            "OpenAI Realtime ストリームが既に停止しています"
        ));
        assert!(!should_emit_realtime_stream_error(
            "ElevenLabs Realtime ストリームが既に停止しています"
        ));
        assert!(!should_emit_realtime_stream_error(
            "Custom Realtime ストリームが既に停止しています"
        ));
        assert!(should_emit_realtime_stream_error(
            "リサンプリングエラー: invalid input"
        ));
    }

    #[test]
    fn test_apple_speech_rejects_multiple_available_streams() {
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            2,
        )
        .unwrap_err();
        assert!(err.contains("Apple SpeechAnalyzer"));
        assert!(err.contains("同時文字起こし"));
    }

    #[test]
    fn test_apple_speech_allows_single_available_stream() {
        validate_stream_count_for_engine(&crate::settings::TranscriptionEngineType::AppleSpeech, 1)
            .expect("single Apple Speech stream should be allowed");
    }

    #[test]
    fn test_other_engines_allow_multiple_available_streams() {
        for engine in [
            crate::settings::TranscriptionEngineType::Whisper,
            crate::settings::TranscriptionEngineType::OpenAIRealtime,
            crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
        ] {
            validate_stream_count_for_engine(&engine, 2)
                .expect("non Apple Speech engines should keep dual stream support");
        }
    }

    #[test]
    fn test_transcription_segment_serialization() {
        // speaker: None の場合、JSONに speaker フィールドが含まれないことを確認
        let segment = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            source: None,
            speaker: None,
            is_error: None,
        };
        let json = serde_json::to_string(&segment).unwrap();
        assert!(json.contains("startMs"));
        assert!(json.contains("endMs"));
        assert!(!json.contains("start_ms"));
        assert!(
            !json.contains("speaker"),
            "speaker: None should be skipped in JSON"
        );
        assert!(
            !json.contains("isError"),
            "is_error: None should be skipped in JSON"
        );

        // speaker: Some("自分") の場合、JSONに speaker フィールドが含まれることを確認
        let segment_with_speaker = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            source: Some(TranscriptionSource::Microphone),
            speaker: Some("自分".to_string()),
            is_error: Some(true),
        };
        let json_with_speaker = serde_json::to_string(&segment_with_speaker).unwrap();
        assert!(
            json_with_speaker.contains("\"speaker\":\"自分\""),
            "speaker: Some(\"自分\") should appear in JSON"
        );
        assert!(
            json_with_speaker.contains("\"source\":\"microphone\""),
            "source should serialize as snake_case"
        );
        assert!(
            json_with_speaker.contains("\"isError\":true"),
            "is_error: Some(true) should serialize as isError"
        );
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

    #[test]
    fn test_whisper_stream_feed_errors_when_resampler_state_missing() {
        let mut stream = stream_with_missing_resampler(Vec::new());
        let err = stream.feed(&[0.0]).unwrap_err();
        assert!(err.contains("リサンプラー状態が利用できません"));
    }

    #[test]
    fn test_whisper_stream_finalize_errors_when_resampler_state_missing() {
        let stream = stream_with_missing_resampler(vec![0.0]);
        let err = Box::new(stream).finalize().unwrap_err();
        assert!(err.contains("リサンプラー状態が利用できません"));
    }

    // ─────────────────────────────────────────
    // TranscriptionEngine / TranscriptionStream trait テスト
    // ─────────────────────────────────────────
    //
    // Whisper の実モデルをロードせずに trait の振る舞いを検証する。
    // モックエンジンが受け取ったサンプル数とライフサイクル (feed → drain →
    // finalize) を記録し、新 trait の契約が壊れていないことを確認する。

    use std::sync::atomic::AtomicUsize;

    /// テスト用モックエンジン。`feed` で受け取ったサンプル合計を記録し、
    /// `feed` 1 回ごとに 1 セグメントを出す。`finalize` 時には特殊セグメントを 1 つ追加する。
    struct MockEngine {
        feeds_seen: Arc<AtomicUsize>,
        samples_seen: Arc<AtomicUsize>,
    }

    struct MockStream {
        speaker: Option<String>,
        source: Option<TranscriptionSource>,
        feeds_seen: Arc<AtomicUsize>,
        samples_seen: Arc<AtomicUsize>,
        pending: Vec<TranscriptionSegment>,
    }

    impl TranscriptionEngine for MockEngine {
        fn start_stream(
            self: Arc<Self>,
            config: StreamConfig,
        ) -> Result<Box<dyn TranscriptionStream>, String> {
            Ok(Box::new(MockStream {
                speaker: config.speaker,
                source: config.source,
                feeds_seen: Arc::clone(&self.feeds_seen),
                samples_seen: Arc::clone(&self.samples_seen),
                pending: Vec::new(),
            }))
        }
    }

    impl TranscriptionStream for MockStream {
        fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
            self.feeds_seen.fetch_add(1, Ordering::SeqCst);
            self.samples_seen.fetch_add(samples.len(), Ordering::SeqCst);
            self.pending.push(TranscriptionSegment {
                text: format!("feed-{}", self.feeds_seen.load(Ordering::SeqCst)),
                start_ms: 0,
                end_ms: 100,
                source: self.source,
                speaker: self.speaker.clone(),
                is_error: None,
            });
            Ok(())
        }

        fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
            std::mem::take(&mut self.pending)
        }

        fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
            self.pending.push(TranscriptionSegment {
                text: "finalized".to_string(),
                start_ms: 0,
                end_ms: 0,
                source: self.source,
                speaker: self.speaker.clone(),
                is_error: None,
            });
            Ok(std::mem::take(&mut self.pending))
        }
    }

    #[test]
    fn test_stream_lifecycle_feed_drain_finalize() {
        let feeds = Arc::new(AtomicUsize::new(0));
        let samples = Arc::new(AtomicUsize::new(0));
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::clone(&feeds),
            samples_seen: Arc::clone(&samples),
        });

        let mut stream = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("自分".to_string()),
                source: Some(TranscriptionSource::Microphone),
                language: Some("ja".to_string()),
            })
            .expect("start_stream should succeed");

        // feed を 2 回実行
        stream.feed(&vec![0.0_f32; 100]).unwrap();
        stream.feed(&vec![0.0_f32; 200]).unwrap();
        assert_eq!(feeds.load(Ordering::SeqCst), 2);
        assert_eq!(samples.load(Ordering::SeqCst), 300);

        // drain で 2 セグメント取り出す
        let drained = stream.drain_segments();
        assert_eq!(drained.len(), 2);
        assert!(drained.iter().all(|s| s.speaker.as_deref() == Some("自分")));
        assert!(drained
            .iter()
            .all(|s| s.source == Some(TranscriptionSource::Microphone)));

        // 連続 drain は空
        assert!(stream.drain_segments().is_empty());

        // finalize で残りの finalized セグメントが 1 つ返る
        let final_segments = stream.finalize().unwrap();
        assert_eq!(final_segments.len(), 1);
        assert_eq!(final_segments[0].text, "finalized");
    }

    #[test]
    fn test_stream_config_speaker_propagates_to_segments() {
        // start_stream に渡した speaker が、各 stream のセグメントに反映される。
        // マイク (自分) とシステム音声 (相手側) を別ストリームで動かす運用の前提。
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::new(AtomicUsize::new(0)),
            samples_seen: Arc::new(AtomicUsize::new(0)),
        });

        let mut mic = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("自分".to_string()),
                source: Some(TranscriptionSource::Microphone),
                language: None,
            })
            .unwrap();
        let mut sys = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("相手側".to_string()),
                source: Some(TranscriptionSource::SystemAudio),
                language: None,
            })
            .unwrap();

        mic.feed(&[0.0; 10]).unwrap();
        sys.feed(&[0.0; 10]).unwrap();

        let mic_segs = mic.drain_segments();
        let sys_segs = sys.drain_segments();
        assert_eq!(mic_segs[0].speaker.as_deref(), Some("自分"));
        assert_eq!(sys_segs[0].speaker.as_deref(), Some("相手側"));
        assert_eq!(mic_segs[0].source, Some(TranscriptionSource::Microphone));
        assert_eq!(sys_segs[0].source, Some(TranscriptionSource::SystemAudio));
    }

    #[test]
    fn test_feed_empty_samples_is_noop_in_mock() {
        // 空 feed でもエラーにならず、後続の feed が引き続き動くこと
        let feeds = Arc::new(AtomicUsize::new(0));
        let samples = Arc::new(AtomicUsize::new(0));
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::clone(&feeds),
            samples_seen: Arc::clone(&samples),
        });
        let mut stream = engine
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: None,
                source: None,
                language: None,
            })
            .unwrap();

        stream.feed(&[]).unwrap();
        stream.feed(&[1.0, 2.0, 3.0]).unwrap();
        // モックは feed 回数を必ずカウントする
        assert_eq!(feeds.load(Ordering::SeqCst), 2);
        assert_eq!(samples.load(Ordering::SeqCst), 3);
    }

    // ─────────────────────────────────────────
    // ensure_engine — エンジン種別ディスパッチ / 再ロード抑制
    // ─────────────────────────────────────────

    #[test]
    fn test_ensure_engine_apple_speech_errors_off_macos() {
        // 非 macOS では AppleSpeech は使えないので明示エラー。
        // Whisper 側の実装に切り替えてくださいというヒント文言を含む。
        // (macOS テスト環境ではこのテストは失敗するので skip する)
        if cfg!(target_os = "macos") {
            return;
        }
        let mut manager = TranscriptionManager::new();
        let err = manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::AppleSpeech,
                "small",
            )
            .unwrap_err();
        assert!(err.contains("macOS"));
    }

    #[test]
    fn test_ensure_engine_openai_loads_engine_without_api_key_check() {
        // OpenAI エンジンは start_stream 時に Keychain から API キーを取得するので、
        // ensure_engine 自体は成功する。実 WebSocket 接続は start_stream まで遅延する。
        let mut manager = TranscriptionManager::new();
        manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::OpenAIRealtime,
                "small",
            )
            .expect("OpenAI エンジンの ensure_engine は同期的には成功する");
        assert!(manager.is_engine_loaded());
    }

    #[test]
    fn test_ensure_engine_elevenlabs_loads_engine_without_api_key_check() {
        // ElevenLabs も start_stream 時に Keychain から API キーを取得する。
        // ensure_engine 自体は課金・通信を発生させず、同期的に成功する。
        let mut manager = TranscriptionManager::new();
        manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
                "small",
            )
            .expect("ElevenLabs エンジンの ensure_engine は同期的には成功する");
        assert!(manager.is_engine_loaded());
    }

    // ─────────────────────────────────────────
    // 沈黙検知ロジック テスト
    // ─────────────────────────────────────────

    #[test]
    fn test_calculate_rms_empty_slice_returns_zero() {
        assert_eq!(calculate_rms(&[]), 0.0);
    }

    #[test]
    fn test_calculate_rms_silence_signal_below_threshold() {
        let samples = vec![0.0001_f32; 16000]; // -80dBFS 相当
        let rms = calculate_rms(&samples);
        assert!(
            rms < SILENCE_THRESHOLD_RMS,
            "rms={rms} should be below SILENCE_THRESHOLD_RMS={SILENCE_THRESHOLD_RMS}"
        );
    }

    #[test]
    fn test_calculate_rms_voice_signal_above_threshold() {
        let samples = vec![0.1_f32; 16000]; // -20dBFS 相当
        let rms = calculate_rms(&samples);
        assert!(
            rms > SILENCE_THRESHOLD_RMS,
            "rms={rms} should be above SILENCE_THRESHOLD_RMS={SILENCE_THRESHOLD_RMS}"
        );
    }

    #[test]
    fn test_is_tail_silent_returns_false_when_buffer_too_short() {
        // buffer.len() < lookback の場合は誤検知防止のため false を返す
        let buffer = vec![0.0001_f32; SILENCE_LOOKBACK_SAMPLES - 1];
        assert!(
            !is_tail_silent(&buffer, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS),
            "buffer shorter than lookback should return false"
        );
    }

    #[test]
    fn test_is_tail_silent_detects_voice_then_silence_pattern() {
        // 1 秒の音声 (-20dBFS) + 0.5 秒の沈黙 (-80dBFS)
        let mut buffer = vec![0.1_f32; MIN_FLUSH_SAMPLES];
        buffer.extend(vec![0.0001_f32; SILENCE_LOOKBACK_SAMPLES]);
        assert!(
            is_tail_silent(&buffer, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS),
            "tail silence should be detected in voice+silence pattern"
        );
    }

    #[test]
    fn test_is_tail_silent_rejects_voice_then_voice() {
        // 全部音声レベル (0.1) では沈黙と判定されないこと
        let buffer = vec![0.1_f32; MIN_FLUSH_SAMPLES + SILENCE_LOOKBACK_SAMPLES];
        assert!(
            !is_tail_silent(&buffer, SILENCE_LOOKBACK_SAMPLES, SILENCE_THRESHOLD_RMS),
            "all-voice buffer should not be detected as silent"
        );
    }

    // ─────────────────────────────────────────
    // モデル未ダウンロード エラーパス テスト
    // ─────────────────────────────────────────

    #[test]
    fn load_model_returns_error_when_model_not_downloaded() {
        let mut manager = TranscriptionManager::new();
        let err = manager
            .load_model("__nonexistent_test_model_xyz_999__")
            .unwrap_err();
        assert!(
            err.starts_with("モデルがダウンロードされていません:"),
            "unexpected error: {err}"
        );
        assert!(!manager.is_engine_loaded());
    }

    #[test]
    fn ensure_engine_returns_error_when_whisper_model_not_downloaded() {
        let mut manager = TranscriptionManager::new();
        let err = manager
            .ensure_engine(
                &crate::settings::TranscriptionEngineType::Whisper,
                "__nonexistent_test_model_xyz_999__",
            )
            .unwrap_err();
        assert!(
            err.starts_with("モデルがダウンロードされていません:"),
            "unexpected error: {err}"
        );
        assert!(!manager.is_engine_loaded());
        // 2 回目も Err: loaded_engine_signature が記録されていないことの間接確認
        let result2 = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__nonexistent_test_model_xyz_999__",
        );
        assert!(result2.is_err());
    }

    #[test]
    fn ensure_engine_does_not_set_engine_on_whisper_failure() {
        let mut manager = TranscriptionManager::new();
        let result = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__nonexistent_test_model_xyz_999__",
        );
        assert!(result.is_err());
        assert!(!manager.is_engine_loaded());
        // 別モデル名でも依然 Err: engine も signature も汚染されていない
        let result2 = manager.ensure_engine(
            &crate::settings::TranscriptionEngineType::Whisper,
            "__another_nonexistent_test_model_999__",
        );
        assert!(result2.is_err());
    }

    #[test]
    fn parse_requested_transcription_sources_returns_exact_error_message_for_unknown_value() {
        let err = parse_requested_transcription_sources(Some("xyz"))
            .expect_err("unknown source should be rejected");
        assert_eq!(
            err,
            "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_rejects_uppercase_known_values() {
        for source in ["BOTH", "Microphone", "System_Audio", "Both"] {
            let err = parse_requested_transcription_sources(Some(source))
                .expect_err("uppercase source should be rejected");
            assert_eq!(
                err,
                "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。",
                "unexpected error for {source:?}"
            );
        }
    }

    #[test]
    fn parse_requested_transcription_sources_error_message_contains_source_constants() {
        let err = parse_requested_transcription_sources(Some("xyz"))
            .expect_err("unknown source should be rejected");
        assert!(
            err.contains(TRANSCRIPTION_SOURCE_MICROPHONE),
            "error message should contain TRANSCRIPTION_SOURCE_MICROPHONE ({TRANSCRIPTION_SOURCE_MICROPHONE:?}): {err:?}"
        );
        assert!(
            err.contains(TRANSCRIPTION_SOURCE_SYSTEM_AUDIO),
            "error message should contain TRANSCRIPTION_SOURCE_SYSTEM_AUDIO ({TRANSCRIPTION_SOURCE_SYSTEM_AUDIO:?}): {err:?}"
        );
    }

    #[test]
    fn should_emit_realtime_stream_error_is_logical_negation_of_already_stopped() {
        for input in [
            "Realtime ストリームが既に停止しています",
            "リサンプリングエラー: invalid",
            "",
            "Realtime ストリーム",
            "OpenAI Realtime ストリームが既に停止しています extra suffix",
        ] {
            assert_eq!(
                should_emit_realtime_stream_error(input),
                !is_realtime_stream_already_stopped_error(input),
                "symmetry violated for input: {input:?}"
            );
        }
    }

    #[test]
    fn build_worker_panic_error_payload_omits_source_when_none() {
        let payload = build_worker_panic_error_payload(None);
        let v = transcription_error_payload_to_value(&payload);
        assert!(v.get("source").is_none());
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("文字起こしワーカーが異常終了しました")
        );
    }

    #[test]
    fn build_transcription_error_payload_preserves_empty_error_string() {
        let payload =
            build_transcription_error_payload(String::new(), Some(TranscriptionSource::Microphone));
        let v = transcription_error_payload_to_value(&payload);
        assert_eq!(v.get("error").and_then(|x| x.as_str()), Some(""));
    }

    // --- validate_stream_count_for_engine boundary + 文言完全一致 ---

    #[test]
    fn validate_stream_count_for_engine_apple_speech_rejects_two_with_exact_error_message() {
        // 既存テストは contains 部分一致のみ。完全一致で UI 文言契約を固定する
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            2,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。",
            "クラッシュ防止の UI 文言を完全一致で固定 (UI/log 文言契約)"
        );
    }

    #[test]
    fn validate_stream_count_for_engine_apple_speech_rejects_three_streams_with_same_error_message()
    {
        // stream_count=3 でも 2 と同じエラー文言で reject される (`stream_count > 1` の boundary 挙動)
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            3,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Apple SpeechAnalyzer は現在、マイクと相手側音声の同時文字起こしを安全に処理できません。クラッシュを防ぐため、どちらか片方の音声ソースだけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。",
            "stream_count=3 でも 2 と同じエラー文言で reject される (`stream_count > 1` の boundary 挙動)"
        );
    }

    #[test]
    fn validate_stream_count_for_engine_apple_speech_rejects_usize_max_streams() {
        // usize::MAX boundary でも overflow なく `stream_count > 1` 条件が成立し reject される現契約
        let err = validate_stream_count_for_engine(
            &crate::settings::TranscriptionEngineType::AppleSpeech,
            usize::MAX,
        )
        .unwrap_err();
        assert!(
            err.contains("Apple SpeechAnalyzer"),
            "usize::MAX boundary でも reject される (overflow ガードなしの現契約)"
        );
    }

    #[test]
    fn validate_stream_count_for_engine_apple_speech_allows_zero_streams() {
        // boundary 下限 (0 streams) は `> 1` 条件不成立で Apple Speech でも Ok を返す現契約
        // 既存テストは stream_count=1。0 は boundary の反対側
        validate_stream_count_for_engine(&crate::settings::TranscriptionEngineType::AppleSpeech, 0)
            .expect("stream_count=0 は `> 1` 条件不成立で Apple Speech でも Ok を返す現契約");
    }

    #[test]
    fn validate_stream_count_for_engine_other_engines_allow_zero_and_usize_max_streams() {
        // 既存テストは stream_count=2 のみ。0 と usize::MAX boundary を 3 engine × 2 値で固定
        for engine in [
            crate::settings::TranscriptionEngineType::Whisper,
            crate::settings::TranscriptionEngineType::OpenAIRealtime,
            crate::settings::TranscriptionEngineType::ElevenLabsRealtime,
        ] {
            validate_stream_count_for_engine(&engine, 0)
                .expect("Apple Speech 以外は 0 streams でも Ok を返す現契約");
            validate_stream_count_for_engine(&engine, usize::MAX)
                .expect("Apple Speech 以外は usize::MAX streams でも Ok を返す現契約");
        }
    }

    #[test]
    fn is_realtime_stream_already_stopped_error_is_case_sensitive_for_ascii_realtime_prefix() {
        // 既存 test は "Realtime" 大文字始まりのみ。"realtime" 小文字始まりは
        // substring 一致 ("Realtime ストリームが既に停止しています") を満たさず
        // false を返す現契約を CI 固定。
        // 大小区別を to_lowercase 等で潰す誤改修を検知する装置。
        assert!(
            !is_realtime_stream_already_stopped_error("realtime ストリームが既に停止しています"),
            "ASCII 部分は大小区別される現契約 (substring 一致は case-sensitive)"
        );
        assert!(
            should_emit_realtime_stream_error("realtime ストリームが既に停止しています"),
            "false 判定なら UI emit される (graceful stop 扱いされない)"
        );
    }

    #[test]
    fn is_realtime_stream_already_stopped_error_matches_substring_at_any_position() {
        // 既存 test は prefix 付き ("OpenAI Realtime ..." 等) と prefix なし
        // ("Realtime ストリーム..." property test 内) のみ。
        // substring が文字列の中間に出現するケース (prefix + suffix 両方付き) は未保護。
        // contains() 仕様上 true を返す現契約を CI 固定 (誤って startsWith 化する改修を検知)。
        assert!(
            is_realtime_stream_already_stopped_error(
                "WARNING: OpenAI Realtime ストリームが既に停止しています (graceful)"
            ),
            "substring が中間 (prefix + suffix 両側) に出現しても true (contains 任意位置一致)"
        );
        assert!(
            !should_emit_realtime_stream_error(
                "WARNING: OpenAI Realtime ストリームが既に停止しています (graceful)"
            ),
            "true 判定なら UI emit を抑止 (graceful stop の noise を捨てる)"
        );
    }

    #[test]
    fn is_realtime_stream_already_stopped_error_matches_across_newlines() {
        // 既存 test は単行メッセージのみ。多行メッセージで substring が
        // 行をまたいで出現しないケースでも、contains() は \n を区切らないため
        // true を返す現契約を CI 固定。
        // 例: "ERROR\nOpenAI Realtime ストリームが既に停止しています\nstack trace..."
        let multiline =
            "ERROR\nOpenAI Realtime ストリームが既に停止しています\nstack trace at line 42";
        assert!(
            is_realtime_stream_already_stopped_error(multiline),
            "改行を含む多行メッセージでも substring が単一行内にあれば true"
        );
        assert!(
            !should_emit_realtime_stream_error(multiline),
            "true なら UI emit 抑止 (多行 stack trace 含む graceful stop も noise として捨てる)"
        );
    }

    #[test]
    fn build_transcription_error_payload_serialization_with_microphone_source() {
        // 既存 test_transcription_error_payload_serialization_with_source は SystemAudio のみカバー。
        // Microphone enum バリアントの serialization (snake_case → "microphone") を CI 固定。
        // 2x2 マトリクス (関数 × TranscriptionSource enum) の未保護セルを充填。
        let payload = build_transcription_error_payload(
            "マイク入力の処理に失敗しました".to_string(),
            Some(TranscriptionSource::Microphone),
        );
        assert_eq!(
            transcription_error_payload_to_value(&payload),
            serde_json::json!({
                "error": "マイク入力の処理に失敗しました",
                "source": "microphone",
            })
        );
    }

    #[test]
    fn build_worker_panic_error_payload_serialization_with_system_audio_source() {
        // 既存 test_worker_panic_payload_does_not_expose_panic_details は Microphone のみ、
        // build_worker_panic_error_payload_omits_source_when_none は None のみ。
        // SystemAudio enum バリアントは未保護 = 2x2 マトリクス (関数 × source) の最後の未充填セル。
        // panic details 漏洩防止と source 値の正確性を同時に CI 固定。
        let payload = build_worker_panic_error_payload(Some(TranscriptionSource::SystemAudio));
        let v = transcription_error_payload_to_value(&payload);
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("文字起こしワーカーが異常終了しました"),
            "panic 文言は固定 (panic details 漏洩防止)"
        );
        assert_eq!(
            v.get("source").and_then(|x| x.as_str()),
            Some("system_audio"),
            "SystemAudio enum バリアントは snake_case で system_audio に serialize される"
        );
        let serialized = v.to_string();
        assert!(
            !serialized.contains("panic"),
            "panic という文字列を含まない"
        );
        assert!(
            !serialized.contains("payload"),
            "payload という文字列を含まない"
        );
    }

    #[test]
    fn build_transcription_error_payload_escapes_newlines_in_error_string() {
        // 改行を含む error 文字列が serde_json 標準で "\\n" にエスケープされる現契約を CI 固定。
        // Tauri event payload (Rust → JS string) として渡る際、改行が JSON valid な escape sequence
        // であることを保証 = フロントエンド側で JSON.parse 後に \n として復元される互換性を保護。
        // 例: "ERROR\nstack trace\n  at line 42" のような複数行 error も payload として安全に運べる。
        let payload = build_transcription_error_payload(
            "ERROR\nstack trace\n  at line 42".to_string(),
            Some(TranscriptionSource::SystemAudio),
        );
        let v = transcription_error_payload_to_value(&payload);
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("ERROR\nstack trace\n  at line 42"),
            "as_str() で取り出すと \\n は復元される (JSON 内部表現は \\\\n だが Value 経由で透過)"
        );
        let serialized = v.to_string();
        assert!(
            serialized.contains(r"ERROR\nstack trace\n  at line 42"),
            "to_string() の生 JSON 文字列では改行が \\\\n にエスケープされる: {serialized}"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_trims_tab_and_newline_whitespace() {
        // 既存 test_parse_requested_transcription_sources_accepts_known_values は
        // ASCII 半角 SP の前後 trim のみカバー。
        // タブ (\t) と改行 (\n) も str::trim() 対象 (ASCII whitespace) であることを CI 固定。
        // trim_matches(' ') 等の限定 trim への誤改修を検知する装置。
        assert_eq!(
            parse_requested_transcription_sources(Some("\tmicrophone\n")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            },
            "タブと改行も str::trim() で除去される (ASCII whitespace 全般)"
        );
        assert_eq!(
            parse_requested_transcription_sources(Some(" \t\nboth\n\t ")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            "複数種類の ASCII whitespace 混在も全て trim される"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_trims_unicode_full_width_space_u3000() {
        // Rust の str::trim() は Unicode White_Space プロパティ (UCD) に従い、
        // U+3000 (全角空白) も削除する。
        // 既存 test は U+3000 trim を未保護 = 将来 trim_ascii() 等への変更で挙動変わる。
        // 現契約 (Unicode whitespace 全般を trim) を CI 固定する装置。
        assert_eq!(
            parse_requested_transcription_sources(Some("\u{3000}microphone\u{3000}")).unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: false,
            },
            "U+3000 (全角空白) も str::trim() で除去される現契約 (Unicode White_Space 準拠)"
        );
        assert_eq!(
            parse_requested_transcription_sources(Some("\u{3000}\u{3000}both\u{3000}\u{3000}"))
                .unwrap(),
            RequestedTranscriptionSources {
                use_mic: true,
                use_system: true,
            },
            "複数の U+3000 連続も全て trim される"
        );
    }

    #[test]
    fn parse_requested_transcription_sources_rejects_prefix_extension_inputs() {
        // 既存 rejects_unknown_values は "mic" / "system" 等の短縮形のみカバー。
        // "microphone_extra" / "both_only" のような prefix が known value と一致するが
        // suffix が付いた拡張入力は未保護。match 完全一致仕様 (= starts_with でない) を
        // CI 固定する装置 = `starts_with` / `contains` 化への誤改修を検知。
        for source in [
            "microphone_extra",
            "system_audio_full",
            "both_only",
            "microphoneX",
        ] {
            let err = parse_requested_transcription_sources(Some(source))
                .expect_err("prefix 一致のみの拡張入力は reject されるべき");
            assert_eq!(
                err,
                "文字起こしソースが不正です。microphone、system_audio、both のいずれかを指定してください。",
                "prefix 拡張入力 {source:?} は完全一致 match を通らず reject される現契約"
            );
        }
    }

    #[test]
    fn transcription_error_payload_debug_output_contains_struct_name_field_names_and_some_variant_with_enum_name(
    ) {
        // #[derive(Debug)] 自動派生による「struct with Option<enum> field の Debug 出力」契約の
        // executable specification 化 = 将来 source field の Debug 表現変更や TranscriptionSource
        // variant rename の波及を遮断する装置。
        let payload = TranscriptionErrorPayload {
            error: "msg".to_string(),
            source: Some(TranscriptionSource::SystemAudio),
        };
        let output = format!("{:?}", payload);
        assert!(
            output.contains("TranscriptionErrorPayload"),
            "型名 TranscriptionErrorPayload が含まれる: {output}"
        );
        assert!(
            output.contains("error"),
            "field 名 error が含まれる: {output}"
        );
        assert!(
            output.contains("source"),
            "field 名 source が含まれる: {output}"
        );
        assert!(
            output.contains("msg"),
            "error field の値 msg が含まれる: {output}"
        );
        assert!(
            output.contains("Some"),
            "Option::Some の Debug 表現 Some が含まれる: {output}"
        );
        assert!(
            output.contains("SystemAudio"),
            "enum variant 名 SystemAudio が含まれる: {output}"
        );
        let none_payload = TranscriptionErrorPayload {
            error: "err".to_string(),
            source: None,
        };
        let none_output = format!("{:?}", none_payload);
        assert!(
            none_output.contains("None"),
            "source: None の Debug 出力に None が含まれる: {none_output}"
        );
    }

    #[test]
    fn transcription_error_payload_debug_output_equals_after_clone_for_some_and_none_variants() {
        // #[derive(Debug, Clone)] の組み合わせで clone 後の Debug 出力が 100% 同一である契約を CI 固定。
        // 将来 Clone を手動実装して Option field を加工する誤改修を遮断する装置。
        let some_payload = TranscriptionErrorPayload {
            error: "original".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        assert_eq!(
            format!("{:?}", some_payload),
            format!("{:?}", some_payload.clone()),
            "Some 持ち payload の Debug 出力は clone 後と完全一致する"
        );
        let none_payload = TranscriptionErrorPayload {
            error: "no_source".to_string(),
            source: None,
        };
        assert_eq!(
            format!("{:?}", none_payload),
            format!("{:?}", none_payload.clone()),
            "None 持ち payload の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn transcription_error_payload_partial_eq_holds_reflexive_and_differs_for_distinct_error_or_source(
    ) {
        // #[derive(PartialEq, Eq)] による「全 field が等値判定対象」契約を CI 固定。
        // 将来 PartialEq を手動実装して source を等値判定から除外する誤改修を遮断する装置。
        let a = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        let b = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        assert_eq!(a, b, "同 error + 同 source は等値 (reflexive)");
        let diff_error = TranscriptionErrorPayload {
            error: "different".to_string(),
            source: Some(TranscriptionSource::Microphone),
        };
        assert_ne!(a, diff_error, "異 error / 同 source は不等");
        let diff_source = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: Some(TranscriptionSource::SystemAudio),
        };
        assert_ne!(
            a, diff_source,
            "同 error / 異 source (Microphone vs SystemAudio) は不等"
        );
        let none_source = TranscriptionErrorPayload {
            error: "same".to_string(),
            source: None,
        };
        assert_ne!(a, none_source, "同 error / Some vs None の source 差は不等");
    }

    #[test]
    fn transcription_segment_debug_output_contains_struct_name_all_six_field_names_and_values() {
        // #[derive(Debug)] 派生で struct 名・全 6 snake_case field 名・値・Some/None・enum variant 名が
        // Debug 出力に含まれる契約を CI 固定。将来 Debug を手動実装して field を隠蔽する誤改修を遮断する。
        let segment = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 100,
            end_ms: 2000,
            source: Some(TranscriptionSource::SystemAudio),
            speaker: Some("自分".to_string()),
            is_error: Some(true),
        };
        let dbg = format!("{:?}", segment);
        assert!(
            dbg.contains("TranscriptionSegment"),
            "型名 TranscriptionSegment が含まれる: {dbg}"
        );
        assert!(dbg.contains("text"), "field 名 text が含まれる: {dbg}");
        assert!(
            dbg.contains("start_ms"),
            "field 名 start_ms が含まれる: {dbg}"
        );
        assert!(dbg.contains("end_ms"), "field 名 end_ms が含まれる: {dbg}");
        assert!(dbg.contains("source"), "field 名 source が含まれる: {dbg}");
        assert!(
            dbg.contains("speaker"),
            "field 名 speaker が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("is_error"),
            "field 名 is_error が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("hello"),
            "text field の値 hello が含まれる: {dbg}"
        );
        assert!(dbg.contains("100"), "start_ms の値 100 が含まれる: {dbg}");
        assert!(dbg.contains("2000"), "end_ms の値 2000 が含まれる: {dbg}");
        assert!(dbg.contains("自分"), "speaker の値 自分 が含まれる: {dbg}");
        assert!(dbg.contains("true"), "is_error の値 true が含まれる: {dbg}");
        assert!(
            dbg.contains("Some"),
            "Option::Some の Debug 表現 Some が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("SystemAudio"),
            "enum variant 名 SystemAudio が含まれる: {dbg}"
        );
    }

    #[test]
    fn transcription_segment_debug_output_equals_after_clone_for_some_and_none_variants() {
        // #[derive(Debug, Clone)] の組み合わせで clone 後の Debug 出力が 100% 同一である契約を CI 固定。
        // 将来 Clone を手動実装して Option field を加工する誤改修を遮断する。
        let full = TranscriptionSegment {
            text: "full".to_string(),
            start_ms: 0,
            end_ms: 500,
            source: Some(TranscriptionSource::Microphone),
            speaker: Some("自分".to_string()),
            is_error: Some(false),
        };
        assert_eq!(
            format!("{:?}", full),
            format!("{:?}", full.clone()),
            "全 Some 埋め segment の Debug 出力は clone 後と完全一致する"
        );
        let bare = TranscriptionSegment {
            text: "bare".to_string(),
            start_ms: -1,
            end_ms: 0,
            source: None,
            speaker: None,
            is_error: None,
        };
        assert_eq!(
            format!("{:?}", bare),
            format!("{:?}", bare.clone()),
            "全 Option None segment の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn transcription_segment_serde_serializes_with_camel_case_field_names_and_skips_none_options() {
        // #[serde(rename_all = "camelCase")] + #[serde(skip_serializing_if = "Option::is_none")] の
        // 組み合わせ契約を CI 固定。将来 serde 属性が外されたり個別 rename された誤改修を遮断する。
        let bare = TranscriptionSegment {
            text: "bare".to_string(),
            start_ms: -5,
            end_ms: 0,
            source: None,
            speaker: None,
            is_error: None,
        };
        let json = serde_json::to_string(&bare).unwrap();
        assert!(
            json.contains("\"text\""),
            "必須 field text が JSON に含まれる: {json}"
        );
        assert!(
            json.contains("\"startMs\""),
            "camelCase field startMs が JSON に含まれる: {json}"
        );
        assert!(
            json.contains("\"endMs\""),
            "camelCase field endMs が JSON に含まれる: {json}"
        );
        assert!(
            !json.contains("\"start_ms\""),
            "snake_case field start_ms は JSON に出ない: {json}"
        );
        assert!(
            !json.contains("\"end_ms\""),
            "snake_case field end_ms は JSON に出ない: {json}"
        );
        assert!(
            !json.contains("\"is_error\""),
            "snake_case field is_error は JSON に出ない: {json}"
        );
        assert!(
            !json.contains("\"isError\""),
            "None の isError は JSON に含まれない: {json}"
        );
        assert!(
            !json.contains("\"speaker\""),
            "None の speaker は JSON に含まれない: {json}"
        );
        assert!(
            !json.contains("\"source\""),
            "None の source は JSON に含まれない: {json}"
        );
        let full = TranscriptionSegment {
            text: "full".to_string(),
            start_ms: 10,
            end_ms: 20,
            source: Some(TranscriptionSource::SystemAudio),
            speaker: Some("相手側".to_string()),
            is_error: Some(true),
        };
        let json = serde_json::to_string(&full).unwrap();
        assert!(
            json.contains("\"isError\""),
            "Some の isError は camelCase で JSON に含まれる: {json}"
        );
        assert!(
            !json.contains("\"is_error\""),
            "snake_case の is_error は JSON に出ない: {json}"
        );
        assert!(
            json.contains("\"system_audio\"") || json.contains("system_audio"),
            "TranscriptionSource::SystemAudio の serde 値は snake_case (system_audio): {json}"
        );
    }

    #[test]
    fn transcription_source_debug_output_contains_each_variant_name_per_variant() {
        let mic = TranscriptionSource::Microphone;
        let sys = TranscriptionSource::SystemAudio;
        let dbg_mic = format!("{:?}", mic);
        let dbg_sys = format!("{:?}", sys);
        assert!(
            dbg_mic.contains("Microphone"),
            "Microphone variant の Debug 出力に variant 名 Microphone が含まれる: {dbg_mic}"
        );
        assert!(
            dbg_sys.contains("SystemAudio"),
            "SystemAudio variant の Debug 出力に variant 名 SystemAudio が含まれる: {dbg_sys}"
        );
        assert_ne!(
            dbg_mic, dbg_sys,
            "Microphone と SystemAudio の Debug 出力は異なる"
        );
    }

    #[test]
    fn transcription_source_copy_trait_keeps_original_usable_after_assignment() {
        let original = TranscriptionSource::Microphone;
        let copied = original;
        assert_eq!(
            original, copied,
            "Copy 派生で copied が original の値と等しい"
        );
        assert_eq!(
            original,
            TranscriptionSource::Microphone,
            "Copy 後も original は Microphone のまま使える"
        );
        let s_original = TranscriptionSource::SystemAudio;
        let s_copied = s_original;
        assert_eq!(
            s_original, s_copied,
            "Copy 派生で SystemAudio も copy される"
        );
        assert_eq!(
            s_original,
            TranscriptionSource::SystemAudio,
            "Copy 後も SystemAudio の original は使える"
        );
    }

    #[test]
    fn transcription_source_serde_serializes_each_variant_with_snake_case_value() {
        let cases: &[(TranscriptionSource, &str)] = &[
            (TranscriptionSource::Microphone, "microphone"),
            (TranscriptionSource::SystemAudio, "system_audio"),
        ];
        for (variant, expected) in cases {
            let value = serde_json::to_value(variant).unwrap();
            assert_eq!(
                value,
                serde_json::Value::String((*expected).to_string()),
                "{:?} は serde で {} に serialize される",
                variant,
                expected
            );
            let s = serde_json::to_string(variant).unwrap();
            assert_eq!(
                s,
                format!("\"{}\"", expected),
                "{:?} は serde で \"{}\" に文字列化される",
                variant,
                expected
            );
        }
    }

    #[test]
    fn stream_config_debug_output_contains_struct_name_all_four_field_names_with_some_and_none() {
        let config = StreamConfig {
            sample_rate: 44100,
            speaker: Some("自分".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: Some("ja".to_string()),
        };
        let dbg = format!("{:?}", config);
        assert!(
            dbg.contains("StreamConfig"),
            "Debug 出力に型名 StreamConfig が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("sample_rate"),
            "Debug 出力に field 名 sample_rate が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("speaker"),
            "Debug 出力に field 名 speaker が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("source"),
            "Debug 出力に field 名 source が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("language"),
            "Debug 出力に field 名 language が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("44100"),
            "Debug 出力に sample_rate 値 44100 が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("自分"),
            "Debug 出力に speaker 値が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("ja"),
            "Debug 出力に language 値 ja が含まれる: {dbg}"
        );
        assert!(dbg.contains("Some"), "Debug 出力に Some が含まれる: {dbg}");
        assert!(
            dbg.contains("Microphone"),
            "Debug 出力に enum variant 名 Microphone が含まれる: {dbg}"
        );
        let config2 = StreamConfig {
            sample_rate: 0,
            speaker: None,
            source: None,
            language: None,
        };
        let dbg2 = format!("{:?}", config2);
        assert!(
            dbg2.contains("None"),
            "None config の Debug 出力に None が含まれる: {dbg2}"
        );
        assert!(
            dbg2.contains("0"),
            "None config の Debug 出力に sample_rate 値 0 が含まれる: {dbg2}"
        );
    }

    #[test]
    fn stream_config_debug_output_equals_after_clone_for_some_and_none_variants() {
        let c = StreamConfig {
            sample_rate: 48000,
            speaker: Some("相手側".to_string()),
            source: Some(TranscriptionSource::SystemAudio),
            language: Some("en".to_string()),
        };
        assert_eq!(
            format!("{:?}", c),
            format!("{:?}", c.clone()),
            "全 Some config の Debug 出力は clone 後と完全一致する"
        );
        let c2 = StreamConfig {
            sample_rate: 16000,
            speaker: None,
            source: None,
            language: None,
        };
        assert_eq!(
            format!("{:?}", c2),
            format!("{:?}", c2.clone()),
            "全 None config の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn stream_config_clone_produces_independent_copy_for_option_string_fields() {
        let original = StreamConfig {
            sample_rate: 22050,
            speaker: Some("orig_speaker".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: Some("ja".to_string()),
        };
        let mut cloned = original.clone();
        cloned.speaker = Some("mutated_speaker".to_string());
        cloned.source = Some(TranscriptionSource::SystemAudio);
        cloned.language = None;
        cloned.sample_rate = 99999;
        assert_eq!(
            original.sample_rate, 22050,
            "original の sample_rate は cloned mutation 後も不変"
        );
        assert_eq!(
            original.speaker.as_deref(),
            Some("orig_speaker"),
            "original の speaker は cloned mutation 後も不変"
        );
        assert_eq!(
            original.source,
            Some(TranscriptionSource::Microphone),
            "original の source は cloned mutation 後も不変"
        );
        assert_eq!(
            original.language.as_deref(),
            Some("ja"),
            "original の language は cloned mutation 後も不変"
        );
        assert_eq!(
            cloned.sample_rate, 99999,
            "cloned の sample_rate は mutation で 99999 に変わる"
        );
        assert_eq!(cloned.speaker.as_deref(), Some("mutated_speaker"));
        assert_eq!(cloned.source, Some(TranscriptionSource::SystemAudio));
        assert!(
            cloned.language.is_none(),
            "cloned の language は None に変わる"
        );
    }

    #[test]
    fn model_info_debug_output_contains_struct_name_and_all_four_field_names() {
        let info = ModelInfo {
            name: "tiny-q5_1".to_string(),
            display_name: "Tiny (Q5_1)".to_string(),
            size_mb: 31,
            url: "https://example.com/tiny.bin".to_string(),
        };
        let s = format!("{:?}", info);

        // 型名
        assert!(
            s.contains("ModelInfo"),
            "Debug should contain type name 'ModelInfo': {}",
            s
        );
        // snake_case field 名 (4 個)
        assert!(
            s.contains("name"),
            "Debug should contain field 'name': {}",
            s
        );
        assert!(
            s.contains("display_name"),
            "Debug should contain field 'display_name': {}",
            s
        );
        assert!(
            s.contains("size_mb"),
            "Debug should contain field 'size_mb': {}",
            s
        );
        assert!(s.contains("url"), "Debug should contain field 'url': {}", s);
        // 値
        assert!(
            s.contains("\"tiny-q5_1\""),
            "Debug should contain name value: {}",
            s
        );
        assert!(
            s.contains("\"Tiny (Q5_1)\""),
            "Debug should contain display_name value: {}",
            s
        );
        assert!(
            s.contains("31"),
            "Debug should contain size_mb value: {}",
            s
        );
        assert!(
            s.contains("\"https://example.com/tiny.bin\""),
            "Debug should contain url value: {}",
            s
        );
    }

    #[test]
    fn model_info_clone_produces_independent_copy_for_string_fields_and_size_mb() {
        let original = ModelInfo {
            name: "tiny".to_string(),
            display_name: "Tiny".to_string(),
            size_mb: 31,
            url: "https://example.com/tiny.bin".to_string(),
        };
        let mut cloned = original.clone();

        // cloned を変更
        cloned.name.push_str("-q5_1");
        cloned.display_name = "Tiny (Q5_1)".to_string();
        cloned.size_mb = 99;
        cloned.url = "https://example.com/other.bin".to_string();

        // original が変化していない (deep clone 契約)
        assert_eq!(
            original.name, "tiny",
            "original.name should be unchanged after cloned mutation"
        );
        assert_eq!(
            original.display_name, "Tiny",
            "original.display_name should be unchanged"
        );
        assert_eq!(original.size_mb, 31, "original.size_mb should be unchanged");
        assert_eq!(
            original.url, "https://example.com/tiny.bin",
            "original.url should be unchanged"
        );

        // cloned が確かに変更されている (mutation 自体が起きた裏付け)
        assert_eq!(cloned.name, "tiny-q5_1");
        assert_eq!(cloned.display_name, "Tiny (Q5_1)");
        assert_eq!(cloned.size_mb, 99);
        assert_eq!(cloned.url, "https://example.com/other.bin");
    }

    #[test]
    fn model_info_serialize_uses_camel_case_for_all_four_fields() {
        let info = ModelInfo {
            name: "tiny-q5_1".to_string(),
            display_name: "Tiny (Q5_1)".to_string(),
            size_mb: 31,
            url: "https://example.com/tiny.bin".to_string(),
        };
        let s = serde_json::to_string(&info).expect("ModelInfo should serialize");

        // camelCase 4 key 存在
        assert!(s.contains("\"name\":"), "should contain 'name' key: {}", s);
        assert!(
            s.contains("\"displayName\":"),
            "should contain 'displayName' key: {}",
            s
        );
        assert!(
            s.contains("\"sizeMb\":"),
            "should contain 'sizeMb' key: {}",
            s
        );
        assert!(s.contains("\"url\":"), "should contain 'url' key: {}", s);
        // snake_case 不在 (rename_all 適用の証明)
        assert!(
            !s.contains("\"display_name\":"),
            "should NOT contain snake_case 'display_name': {}",
            s
        );
        assert!(
            !s.contains("\"size_mb\":"),
            "should NOT contain snake_case 'size_mb': {}",
            s
        );
        // 値正しさ
        assert!(
            s.contains("\"tiny-q5_1\""),
            "should contain name value: {}",
            s
        );
        assert!(
            s.contains("\"Tiny (Q5_1)\""),
            "should contain display_name value: {}",
            s
        );
        assert!(
            s.contains(":31"),
            "should contain size_mb numeric value 31: {}",
            s
        );
        assert!(
            s.contains("\"https://example.com/tiny.bin\""),
            "should contain url value: {}",
            s
        );
    }

    #[test]
    fn requested_transcription_sources_debug_output_contains_struct_name_and_both_field_names() {
        // 両 true case
        let both = RequestedTranscriptionSources {
            use_mic: true,
            use_system: true,
        };
        let s_both = format!("{:?}", both);
        assert!(
            s_both.contains("RequestedTranscriptionSources"),
            "Debug should contain type name: {}",
            s_both
        );
        assert!(
            s_both.contains("use_mic"),
            "Debug should contain field 'use_mic': {}",
            s_both
        );
        assert!(
            s_both.contains("use_system"),
            "Debug should contain field 'use_system': {}",
            s_both
        );
        assert!(
            s_both.contains("true"),
            "both-true Debug should contain 'true': {}",
            s_both
        );

        // 両 false case
        let neither = RequestedTranscriptionSources {
            use_mic: false,
            use_system: false,
        };
        let s_neither = format!("{:?}", neither);
        assert!(
            s_neither.contains("RequestedTranscriptionSources"),
            "Debug should contain type name: {}",
            s_neither
        );
        assert!(
            s_neither.contains("use_mic"),
            "Debug should contain field 'use_mic': {}",
            s_neither
        );
        assert!(
            s_neither.contains("use_system"),
            "Debug should contain field 'use_system': {}",
            s_neither
        );
        assert!(
            s_neither.contains("false"),
            "both-false Debug should contain 'false': {}",
            s_neither
        );

        // 混合 case (mic-only) で true と false が両方とも出ることを確認
        let mic_only = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let s_mic = format!("{:?}", mic_only);
        assert!(
            s_mic.contains("true"),
            "mic-only Debug should contain 'true': {}",
            s_mic
        );
        assert!(
            s_mic.contains("false"),
            "mic-only Debug should contain 'false': {}",
            s_mic
        );
    }

    #[test]
    fn requested_transcription_sources_copy_semantics_allow_use_after_move() {
        let original = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        // Copy 派生があれば、let copied = original で move されず、original も使える
        let copied = original;
        // original を copied と独立に使えることを確認
        assert!(
            original.use_mic,
            "original.use_mic should still be readable (Copy)"
        );
        assert!(
            !original.use_system,
            "original.use_system should still be readable (Copy)"
        );
        // copied 側も値が独立して使える
        assert!(copied.use_mic, "copied.use_mic should match");
        assert!(!copied.use_system, "copied.use_system should match");
    }

    #[test]
    fn requested_transcription_sources_partial_eq_holds_reflexive_and_differs_for_each_field() {
        let a = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let same = RequestedTranscriptionSources {
            use_mic: true,
            use_system: false,
        };
        let mic_diff = RequestedTranscriptionSources {
            use_mic: false, // 違う
            use_system: false,
        };
        let system_diff = RequestedTranscriptionSources {
            use_mic: true,
            use_system: true, // 違う
        };
        let both_diff = RequestedTranscriptionSources {
            use_mic: false,
            use_system: true,
        };

        // reflexive 等値
        assert_eq!(a, same, "same field values should be equal");
        // 片方の field 違いで不等値
        assert_ne!(a, mic_diff, "differs by use_mic");
        assert_ne!(a, system_diff, "differs by use_system");
        // 両 field 違いで不等値
        assert_ne!(a, both_diff, "differs by both");
    }
}
