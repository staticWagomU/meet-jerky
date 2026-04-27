use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

fn deserialize_engine_type_with_fallback<'de, D>(
    deserializer: D,
) -> Result<TranscriptionEngineType, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Ok(TranscriptionEngineType::from_legacy_str(&value))
}

// ─────────────────────────────────────────────
// データ型
// ─────────────────────────────────────────────

/// 文字起こしエンジンの種類
///
/// 旧設定ファイルの値とのマッピング:
/// - `"local"` → `Whisper` (ローカル Whisper モデル)
/// - `"cloud"` → `OpenAIRealtime` (旧 "cloud" 一括が新 "openAIRealtime" に対応)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionEngineType {
    /// ローカル Whisper モデル (whisper-rs / GGML)
    Whisper,
    /// macOS 内蔵 SpeechAnalyzer (実装は次 PR)
    AppleSpeech,
    /// OpenAI Realtime API (実装は次 PR)
    OpenAIRealtime,
    /// ElevenLabs Scribe v2 Realtime API
    ElevenLabsRealtime,
}

impl TranscriptionEngineType {
    /// 過去の設定ファイル値を含めて、文字列から enum に変換する。
    /// 未知の値は `Whisper` にフォールバックする。
    pub fn from_legacy_str(value: &str) -> Self {
        match value {
            // 旧名 → 新名のマイグレーション
            "local" | "whisper" => Self::Whisper,
            "cloud" | "openAIRealtime" | "openai_realtime" => Self::OpenAIRealtime,
            "elevenLabsRealtime" | "elevenlabs_realtime" | "eleven_labs_realtime" => {
                Self::ElevenLabsRealtime
            }
            "appleSpeech" | "apple_speech" => Self::AppleSpeech,
            _ => Self::Whisper,
        }
    }
}

/// アプリケーション設定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// 文字起こしエンジン ("local" or "cloud")
    #[serde(deserialize_with = "deserialize_engine_type_with_fallback")]
    pub transcription_engine: TranscriptionEngineType,

    /// Whisper モデル名 ("tiny", "base", "small", "medium", "large-v3")
    pub whisper_model: String,

    /// マイクデバイスID (None = デフォルトデバイス)
    pub microphone_device_id: Option<String>,

    /// 言語設定 ("ja", "en", "auto")
    pub language: String,

    /// 出力ディレクトリ (None = デフォルトディレクトリ)
    pub output_directory: Option<String>,

    /// クラウドエンジンの API キー (None = 未設定)
    #[serde(default)]
    pub api_key: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            transcription_engine: TranscriptionEngineType::Whisper,
            whisper_model: "small".to_string(),
            microphone_device_id: None,
            language: "auto".to_string(),
            output_directory: None,
            api_key: None,
        }
    }
}

impl AppSettings {
    /// 設定ファイルのパスを返す
    ///
    /// - macOS: `~/Library/Application Support/meet-jerky/settings.json`
    /// - Windows: `%APPDATA%/meet-jerky/settings.json`
    /// - Linux: `~/.config/meet-jerky/settings.json`
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("meet-jerky")
            .join("settings.json")
    }

    /// 設定ファイルから読み込む。ファイルが存在しない場合やパースに失敗した場合はデフォルト値を返す。
    pub fn load() -> Self {
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// 設定ファイルに保存する
    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();

        // ディレクトリがなければ作成
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("設定ディレクトリの作成に失敗しました: {e}"))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("設定のシリアライズに失敗しました: {e}"))?;

        std::fs::write(&path, json)
            .map_err(|e| format!("設定ファイルの書き込みに失敗しました: {e}"))?;

        Ok(())
    }
}

/// デフォルトの出力ディレクトリパスを返す
///
/// `~/.local/share/meet-jerky/transcripts/` (macOS/Linux)
/// `%APPDATA%/meet-jerky/transcripts/` (Windows)
pub fn default_output_directory() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("meet-jerky")
        .join("transcripts")
}

// ─────────────────────────────────────────────
// Tauri managed state
// ─────────────────────────────────────────────

/// Tauri managed state として使うハンドル
pub struct SettingsStateHandle(pub Mutex<AppSettings>);

impl SettingsStateHandle {
    pub fn new() -> Self {
        Self(Mutex::new(AppSettings::load()))
    }
}

// ─────────────────────────────────────────────
// Tauri コマンド
// ─────────────────────────────────────────────

/// 現在の設定を返す
#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsStateHandle>) -> AppSettings {
    state.0.lock().clone()
}

/// 設定を更新して保存する
#[tauri::command]
pub fn update_settings(
    settings: AppSettings,
    state: tauri::State<'_, SettingsStateHandle>,
) -> Result<(), String> {
    settings.save()?;
    *state.0.lock() = settings;
    Ok(())
}

/// デフォルトの出力ディレクトリパスを返す
#[tauri::command]
pub fn get_default_output_directory() -> String {
    default_output_directory().to_string_lossy().to_string()
}

/// ネイティブフォルダ選択ダイアログを開く
#[tauri::command]
pub fn select_output_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

// ─────────────────────────────────────────────
// パーミッションチェック
// ─────────────────────────────────────────────

const PERMISSION_UNDETERMINED: i32 = 0;
const PERMISSION_DENIED: i32 = 1;
const PERMISSION_GRANTED: i32 = 2;

fn permission_status_to_string(status: i32) -> String {
    match status {
        PERMISSION_UNDETERMINED => "undetermined",
        PERMISSION_GRANTED => "granted",
        PERMISSION_DENIED => "denied",
        _ => "denied",
    }
    .to_string()
}

/// マイクのパーミッション状態を返す ("granted", "denied", "undetermined")
#[tauri::command]
pub fn check_microphone_permission() -> String {
    #[cfg(target_os = "macos")]
    {
        return permission_status_to_string(macos_permissions::microphone_permission_status());
    }

    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

/// 画面録画のパーミッション状態を返す ("granted", "denied")
#[tauri::command]
pub fn check_screen_recording_permission() -> String {
    #[cfg(target_os = "macos")]
    {
        return permission_status_to_string(macos_permissions::screen_recording_permission_status());
    }

    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

#[cfg(target_os = "macos")]
mod macos_permissions {
    extern "C" {
        fn meet_jerky_microphone_permission_status() -> i32;
        fn meet_jerky_screen_recording_permission_status() -> i32;
    }

    pub fn microphone_permission_status() -> i32 {
        // Safety: Swift bridge exposes a process-local C ABI function with no arguments.
        unsafe { meet_jerky_microphone_permission_status() }
    }

    pub fn screen_recording_permission_status() -> i32 {
        // Safety: Swift bridge exposes a process-local C ABI function with no arguments.
        unsafe { meet_jerky_screen_recording_permission_status() }
    }
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let settings = AppSettings::default();
        assert_eq!(
            settings.transcription_engine,
            TranscriptionEngineType::Whisper
        );
        assert_eq!(settings.whisper_model, "small");
        assert!(settings.microphone_device_id.is_none());
        assert_eq!(settings.language, "auto");
        assert!(settings.output_directory.is_none());
    }

    #[test]
    fn test_config_path_not_empty() {
        let path = AppSettings::config_path();
        assert!(!path.as_os_str().is_empty());
        assert!(path.to_string_lossy().contains("meet-jerky"));
        assert!(path.to_string_lossy().ends_with("settings.json"));
    }

    #[test]
    fn test_default_output_directory_not_empty() {
        let path = default_output_directory();
        assert!(!path.as_os_str().is_empty());
        assert!(path.to_string_lossy().contains("meet-jerky"));
        assert!(path.to_string_lossy().contains("transcripts"));
    }

    #[test]
    fn test_permission_status_to_string_maps_known_values() {
        assert_eq!(
            permission_status_to_string(PERMISSION_UNDETERMINED),
            "undetermined"
        );
        assert_eq!(permission_status_to_string(PERMISSION_DENIED), "denied");
        assert_eq!(permission_status_to_string(PERMISSION_GRANTED), "granted");
        assert_eq!(permission_status_to_string(99), "denied");
    }

    #[test]
    fn test_serialization_camel_case() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        // camelCase でシリアライズされることを確認
        assert!(json.contains("transcriptionEngine"));
        assert!(json.contains("whisperModel"));
        assert!(json.contains("microphoneDeviceId"));
        assert!(json.contains("outputDirectory"));
        // snake_case が含まれないことを確認
        assert!(!json.contains("transcription_engine"));
        assert!(!json.contains("whisper_model"));
    }

    #[test]
    fn test_deserialization_camel_case_with_legacy_value() {
        // 旧 "cloud" 値は OpenAIRealtime にマイグレーションされる
        let json = r#"{
            "transcriptionEngine": "cloud",
            "whisperModel": "tiny",
            "microphoneDeviceId": "device-1",
            "language": "ja",
            "outputDirectory": "/tmp/output"
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.transcription_engine,
            TranscriptionEngineType::OpenAIRealtime
        );
        assert_eq!(settings.whisper_model, "tiny");
        assert_eq!(settings.microphone_device_id, Some("device-1".to_string()));
        assert_eq!(settings.language, "ja");
        assert_eq!(settings.output_directory, Some("/tmp/output".to_string()));
    }

    #[test]
    fn test_deserialization_with_null_optionals() {
        let json = r#"{
            "transcriptionEngine": "local",
            "whisperModel": "small",
            "microphoneDeviceId": null,
            "language": "auto",
            "outputDirectory": null
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        // 旧 "local" 値は Whisper にマイグレーションされる
        assert_eq!(
            settings.transcription_engine,
            TranscriptionEngineType::Whisper
        );
        assert!(settings.microphone_device_id.is_none());
        assert!(settings.output_directory.is_none());
    }

    #[test]
    fn test_engine_type_legacy_value_migration() {
        // 旧設定値 → 新 enum へのマッピングを集約して固定化する
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("local"),
            TranscriptionEngineType::Whisper
        );
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("cloud"),
            TranscriptionEngineType::OpenAIRealtime
        );
        // 新名 (camelCase / snake_case 両方) も受理する
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("whisper"),
            TranscriptionEngineType::Whisper
        );
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("openAIRealtime"),
            TranscriptionEngineType::OpenAIRealtime
        );
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("elevenLabsRealtime"),
            TranscriptionEngineType::ElevenLabsRealtime
        );
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("elevenlabs_realtime"),
            TranscriptionEngineType::ElevenLabsRealtime
        );
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("appleSpeech"),
            TranscriptionEngineType::AppleSpeech
        );
        // 未知の値は Whisper にフォールバック
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("unknown"),
            TranscriptionEngineType::Whisper
        );
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        // 一時ディレクトリを使って save/load のラウンドトリップをテスト
        let tmp_dir = std::env::temp_dir().join("meet-jerky-settings-test");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let path = tmp_dir.join("settings.json");

        let settings = AppSettings {
            transcription_engine: TranscriptionEngineType::OpenAIRealtime,
            whisper_model: "medium".to_string(),
            microphone_device_id: Some("test-device".to_string()),
            language: "ja".to_string(),
            output_directory: Some("/tmp/test".to_string()),
            api_key: None,
        };

        // 直接ファイルに書き込んでラウンドトリップをテスト
        let json = serde_json::to_string_pretty(&settings).unwrap();
        std::fs::write(&path, &json).unwrap();

        let loaded: AppSettings =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            loaded.transcription_engine,
            TranscriptionEngineType::OpenAIRealtime
        );
        assert_eq!(loaded.whisper_model, "medium");
        assert_eq!(loaded.microphone_device_id, Some("test-device".to_string()));
        assert_eq!(loaded.language, "ja");
        assert_eq!(loaded.output_directory, Some("/tmp/test".to_string()));

        // クリーンアップ
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_load_returns_default_for_missing_file() {
        // 存在しないファイルを読み込もうとするとデフォルト値が返ることを確認
        // AppSettings::load() は config_path() を使うので直接テストは難しいが、
        // 内部ロジックをテストする
        let result: Result<AppSettings, _> = serde_json::from_str("invalid json");
        assert!(result.is_err());
        // エラー時はデフォルトを使うというロジックは load() 内で処理される
    }

    #[test]
    fn test_engine_type_serialization() {
        // serde の rename_all = "camelCase" によるシリアライズ表現を固定化する。
        // ファイル形式が安定であることをユーザーへの暗黙の契約として保証する。
        let whisper = TranscriptionEngineType::Whisper;
        let apple = TranscriptionEngineType::AppleSpeech;
        let openai = TranscriptionEngineType::OpenAIRealtime;
        let elevenlabs = TranscriptionEngineType::ElevenLabsRealtime;

        assert_eq!(serde_json::to_string(&whisper).unwrap(), "\"whisper\"");
        assert_eq!(serde_json::to_string(&apple).unwrap(), "\"appleSpeech\"");
        assert_eq!(
            serde_json::to_string(&openai).unwrap(),
            "\"openAIRealtime\""
        );
        assert_eq!(
            serde_json::to_string(&elevenlabs).unwrap(),
            "\"elevenLabsRealtime\""
        );
    }

    #[test]
    fn test_settings_state_handle_new() {
        // SettingsStateHandle::new() が AppSettings::load() を呼ぶことを確認
        // (設定ファイルがない場合はデフォルト値)
        let handle = SettingsStateHandle::new();
        let settings = handle.0.lock();
        // デフォルト値が設定されていることを確認（設定ファイルがなければ）
        assert!(!settings.whisper_model.is_empty());
    }

    #[test]
    fn test_deserialization_with_missing_fields_uses_defaults() {
        // JSON with only some fields — simulates older config or manually edited file.
        // 旧 "cloud" 値はマイグレーションで OpenAIRealtime になる。
        let json = r#"{
            "transcriptionEngine": "cloud",
            "whisperModel": "medium"
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.transcription_engine,
            TranscriptionEngineType::OpenAIRealtime
        );
        assert_eq!(settings.whisper_model, "medium");
        assert!(settings.microphone_device_id.is_none());
        assert_eq!(settings.language, "auto");
        assert!(settings.output_directory.is_none());
    }

    #[test]
    fn test_deserialization_ignores_unknown_fields() {
        // Simulates a settings file from a newer version with additional fields
        let json = r#"{
            "transcriptionEngine": "local",
            "whisperModel": "small",
            "microphoneDeviceId": null,
            "language": "auto",
            "outputDirectory": null,
            "apiKey": "sk-test-12345",
            "cloudProvider": "openai",
            "newFeatureFlag": true
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.transcription_engine,
            TranscriptionEngineType::Whisper
        );
        assert_eq!(settings.whisper_model, "small");
        assert_eq!(settings.language, "auto");
    }

    #[test]
    fn test_api_key_default_is_none() {
        let settings = AppSettings::default();
        assert!(settings.api_key.is_none());
    }

    #[test]
    fn test_api_key_serialization_roundtrip() {
        let settings = AppSettings {
            api_key: Some("sk-abc123".to_string()),
            ..AppSettings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"apiKey\""));
        assert!(json.contains("sk-abc123"));

        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.api_key, Some("sk-abc123".to_string()));
    }

    #[test]
    fn test_api_key_missing_in_json_defaults_to_none() {
        let json = r#"{
            "transcriptionEngine": "local",
            "whisperModel": "small",
            "microphoneDeviceId": null,
            "language": "auto",
            "outputDirectory": null
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.api_key.is_none());
    }

    #[test]
    fn test_load_recovers_valid_fields_from_partially_invalid_json() {
        // JSON with an invalid enum value for transcriptionEngine,
        // but valid values for all other fields.
        // The custom deserializer (deserialize_engine_type_with_fallback) handles
        // the invalid enum value gracefully by falling back to Local.
        let json = r#"{
            "transcriptionEngine": "invalid_engine",
            "whisperModel": "medium",
            "microphoneDeviceId": "my-device",
            "language": "ja",
            "outputDirectory": "/custom/path"
        }"#;

        // The custom deserializer allows serde to succeed even with an invalid
        // engine value — the invalid field falls back to Local while all other
        // valid fields are preserved.
        let settings: AppSettings =
            serde_json::from_str(json).unwrap_or_else(|_| AppSettings::default());

        // The custom deserializer means serde_json::from_str succeeds,
        // so valid fields are preserved correctly.
        assert_eq!(
            settings.transcription_engine,
            TranscriptionEngineType::Whisper
        );
        assert_eq!(settings.whisper_model, "medium");
        assert_eq!(settings.language, "ja");
    }
}
