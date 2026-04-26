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
// TranscriptionEngine / TranscriptionStream トレイト
// ─────────────────────────────────────────────

/// 1 つのストリーミング文字起こしセッションの設定。
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// 入力音声のサンプルレート。エンジン内部で必要に応じてリサンプルする。
    pub sample_rate: u32,
    /// 出力セグメントに付与する話者ラベル ("自分" / "相手" など)。
    pub speaker: Option<String>,
    /// 言語ヒント ("ja" / "en" / "auto")。エンジンが解釈する。
    pub language: Option<String>,
}

/// マイク / システム音声など、複数の音声ソースに対する文字起こしを行う
/// エンジンのファクトリ。
///
/// `start_stream` は呼び出すたびに独立した `TranscriptionStream` を返し、
/// 並行して複数のストリームを動かせる必要がある (マイク + システム音声)。
pub trait TranscriptionEngine: Send + Sync {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String>;
}

/// ストリーミング文字起こしの 1 セッションを表す。
///
/// 呼び出し元は raw PCM サンプルを `feed` で送り込み、確定した
/// セグメントを `drain_segments` で非同期に取り出す。`finalize` で
/// 残りのバッファをフラッシュして最終セグメントを得る。
///
/// 実装はサンプルレート変換やチャンク化、API 呼び出しなどの
/// エンジン固有の責務をすべて内部に閉じ込める。
pub trait TranscriptionStream: Send {
    /// `StreamConfig::sample_rate` で指定したレートのサンプルを送り込む。
    fn feed(&mut self, samples: &[f32]) -> Result<(), String>;

    /// これまでに確定したセグメントを取り出す (非ブロッキング)。
    fn drain_segments(&mut self) -> Vec<TranscriptionSegment>;

    /// 残りのバッファを処理し、最終セグメントを返す。
    /// 呼び出し後はストリームを使わない。
    fn finalize(self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String>;
}

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
                speaker: None,
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
    fn flush_full_chunks(&mut self) -> Result<(), String> {
        while self.accumulation_buffer.len() >= CHUNK_SAMPLES {
            let chunk: Vec<f32> = self.accumulation_buffer.drain(..CHUNK_SAMPLES).collect();
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
                speaker: self.speaker.clone(),
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
    let (engine_type, whisper_model) = {
        let settings = settings_state.0.lock();
        let model = if model_name.is_empty() {
            settings.whisper_model.clone()
        } else {
            model_name.clone()
        };
        (settings.transcription_engine.clone(), model)
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

    let source_str = source.as_deref().unwrap_or("both");

    let use_mic = source_str == "microphone" || source_str == "both";
    let use_system = source_str == "system_audio" || source_str == "both";

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
    if use_mic {
        if let Some(mic_sample_rate) = audio_state.get_sample_rate() {
            let stream_config = StreamConfig {
                sample_rate: mic_sample_rate,
                speaker: Some("自分".to_string()),
                language: None,
            };
            let stream = Arc::clone(&engine)
                .start_stream(stream_config)
                .map_err(|e| {
                    format!("マイク音声の文字起こしストリーム初期化に失敗しました: {e}")
                })?;

            pending_streams.push(PendingTranscriptionStream {
                source: TranscriptionSource::Microphone,
                stream,
            });
        }
    }

    // システム音声用の文字起こしスレッド
    if use_system {
        if let Some(sys_sample_rate) = audio_state.get_system_audio_sample_rate() {
            let stream_config = StreamConfig {
                sample_rate: sys_sample_rate,
                speaker: Some("相手".to_string()),
                language: None,
            };
            let stream = Arc::clone(&engine)
                .start_stream(stream_config)
                .map_err(|e| {
                    format!("システム音声の文字起こしストリーム初期化に失敗しました: {e}")
                })?;

            pending_streams.push(PendingTranscriptionStream {
                source: TranscriptionSource::SystemAudio,
                stream,
            });
        }
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
            run_transcription_loop(worker);
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

enum TranscriptionSource {
    Microphone,
    SystemAudio,
}

struct PendingTranscriptionStream {
    source: TranscriptionSource,
    stream: Box<dyn TranscriptionStream>,
}

struct TranscriptionLoopConfig {
    consumer: ringbuf::HeapCons<f32>,
    stream: Box<dyn TranscriptionStream>,
    running: Arc<AtomicBool>,
    app: tauri::AppHandle,
    session_manager: Arc<crate::session_manager::SessionManager>,
    stream_started_at_secs: u64,
}

fn run_transcription_loop(cfg: TranscriptionLoopConfig) {
    let TranscriptionLoopConfig {
        mut consumer,
        mut stream,
        running,
        app,
        session_manager,
        stream_started_at_secs,
    } = cfg;

    let mut read_buffer: Vec<f32> = vec![0.0; 4096];

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
            eprintln!("文字起こしエラー: {e}");
            let _ = app.emit("transcription-error", serde_json::json!({ "error": e }));
        }

        emit_segments(
            stream.drain_segments(),
            &app,
            &session_manager,
            stream_started_at_secs,
        );

        std::thread::sleep(Duration::from_millis(50));
    }

    // 停止フラグが立ったら、残ったバッファをフラッシュして最終セグメントを emit する。
    match stream.finalize() {
        Ok(remaining) => {
            emit_segments(remaining, &app, &session_manager, stream_started_at_secs);
        }
        Err(e) => {
            eprintln!("文字起こしの finalize に失敗しました: {e}");
            let _ = app.emit("transcription-error", serde_json::json!({ "error": e }));
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
        if let Some((sp, off, tx)) = crate::transcript_bridge::build_append_args_for_emission(
            &segment,
            session_started_at_secs,
            stream_started_at_secs,
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

    fn stream_with_missing_resampler(resample_input_buffer: Vec<f32>) -> WhisperStream {
        WhisperStream {
            ctx: None,
            speaker: None,
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
        assert!(
            !json.contains("speaker"),
            "speaker: None should be skipped in JSON"
        );

        // speaker: Some("自分") の場合、JSONに speaker フィールドが含まれることを確認
        let segment_with_speaker = TranscriptionSegment {
            text: "hello".to_string(),
            start_ms: 1000,
            end_ms: 2000,
            speaker: Some("自分".to_string()),
        };
        let json_with_speaker = serde_json::to_string(&segment_with_speaker).unwrap();
        assert!(
            json_with_speaker.contains("\"speaker\":\"自分\""),
            "speaker: Some(\"自分\") should appear in JSON"
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
                speaker: self.speaker.clone(),
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
                speaker: self.speaker.clone(),
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
        // マイク (自分) とシステム音声 (相手) を別ストリームで動かす運用の前提。
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::new(AtomicUsize::new(0)),
            samples_seen: Arc::new(AtomicUsize::new(0)),
        });

        let mut mic = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("自分".to_string()),
                language: None,
            })
            .unwrap();
        let mut sys = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("相手".to_string()),
                language: None,
            })
            .unwrap();

        mic.feed(&[0.0; 10]).unwrap();
        sys.feed(&[0.0; 10]).unwrap();

        let mic_segs = mic.drain_segments();
        let sys_segs = sys.drain_segments();
        assert_eq!(mic_segs[0].speaker.as_deref(), Some("自分"));
        assert_eq!(sys_segs[0].speaker.as_deref(), Some("相手"));
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
}
