use std::path::PathBuf;
use std::time::Duration;

use crate::transcription_types::ModelInfo;

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
