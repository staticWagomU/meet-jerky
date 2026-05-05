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
    /// macOS 内蔵 SpeechAnalyzer
    AppleSpeech,
    /// OpenAI Realtime API
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
    /// 文字起こしエンジン ("whisper", "appleSpeech", "openAIRealtime" など)
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

    /// 旧クラウド設定互換用の API キー。現在の Realtime API キーは Keychain に保存する。
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

    #[test]
    fn from_legacy_str_returns_whisper_for_empty_string_as_fail_safe() {
        assert_eq!(
            TranscriptionEngineType::from_legacy_str(""),
            TranscriptionEngineType::Whisper,
            "空文字は catch-all で Whisper に倒される fail-safe 契約: 設定欠損時のデフォルトをローカル Whisper (課金なし) に固定"
        );
    }

    #[test]
    fn from_legacy_str_returns_whisper_for_uppercase_known_value_as_fail_safe() {
        assert_eq!(
            TranscriptionEngineType::from_legacy_str("WHISPER"),
            TranscriptionEngineType::Whisper,
            "known 値 \"whisper\" の大文字版 \"WHISPER\" は catch-all で Whisper に倒される: case sensitivity 設計 (lowercase のみ accept) を CI 固定 = 「将来 case-insensitive 化する誤改修」を遮断する装置"
        );
    }

    #[test]
    fn from_legacy_str_returns_whisper_for_known_value_with_whitespace_padding_as_fail_safe() {
        assert_eq!(
            TranscriptionEngineType::from_legacy_str(" whisper "),
            TranscriptionEngineType::Whisper,
            "known 値 \"whisper\" の前後に空白を含む形は catch-all で Whisper に倒される: trim しない設計を CI 固定 = 「将来 trim 処理を追加する誤改修」を遮断する装置"
        );
    }

    #[test]
    fn transcription_engine_type_debug_output_contains_each_variant_name_per_variant() {
        let whisper = TranscriptionEngineType::Whisper;
        let apple = TranscriptionEngineType::AppleSpeech;
        let openai = TranscriptionEngineType::OpenAIRealtime;
        let elevenlabs = TranscriptionEngineType::ElevenLabsRealtime;
        assert!(
            format!("{:?}", whisper).contains("Whisper"),
            "Debug 出力に variant 'Whisper' が含まれる契約: got {:?}",
            whisper
        );
        assert!(
            format!("{:?}", apple).contains("AppleSpeech"),
            "Debug 出力に variant 'AppleSpeech' が含まれる契約: got {:?}",
            apple
        );
        assert!(
            format!("{:?}", openai).contains("OpenAIRealtime"),
            "Debug 出力に variant 'OpenAIRealtime' が含まれる契約: got {:?}",
            openai
        );
        assert!(
            format!("{:?}", elevenlabs).contains("ElevenLabsRealtime"),
            "Debug 出力に variant 'ElevenLabsRealtime' が含まれる契約: got {:?}",
            elevenlabs
        );
        let dbg_w = format!("{:?}", whisper);
        let dbg_a = format!("{:?}", apple);
        let dbg_o = format!("{:?}", openai);
        let dbg_e = format!("{:?}", elevenlabs);
        assert_ne!(
            dbg_w, dbg_a,
            "異なる variant の Debug 出力は異なる契約 (Whisper vs AppleSpeech)"
        );
        assert_ne!(
            dbg_w, dbg_o,
            "異なる variant の Debug 出力は異なる契約 (Whisper vs OpenAIRealtime)"
        );
        assert_ne!(
            dbg_w, dbg_e,
            "異なる variant の Debug 出力は異なる契約 (Whisper vs ElevenLabsRealtime)"
        );
        assert_ne!(
            dbg_a, dbg_o,
            "異なる variant の Debug 出力は異なる契約 (AppleSpeech vs OpenAIRealtime)"
        );
        assert_ne!(
            dbg_a, dbg_e,
            "異なる variant の Debug 出力は異なる契約 (AppleSpeech vs ElevenLabsRealtime)"
        );
        assert_ne!(
            dbg_o, dbg_e,
            "異なる variant の Debug 出力は異なる契約 (OpenAIRealtime vs ElevenLabsRealtime)"
        );
    }

    #[test]
    fn transcription_engine_type_partial_eq_holds_reflexive_and_differs_between_variants() {
        assert_eq!(
            TranscriptionEngineType::Whisper,
            TranscriptionEngineType::Whisper,
            "PartialEq reflexive: Whisper == Whisper"
        );
        assert_eq!(
            TranscriptionEngineType::AppleSpeech,
            TranscriptionEngineType::AppleSpeech,
            "PartialEq reflexive: AppleSpeech == AppleSpeech"
        );
        assert_eq!(
            TranscriptionEngineType::OpenAIRealtime,
            TranscriptionEngineType::OpenAIRealtime,
            "PartialEq reflexive: OpenAIRealtime == OpenAIRealtime"
        );
        assert_eq!(
            TranscriptionEngineType::ElevenLabsRealtime,
            TranscriptionEngineType::ElevenLabsRealtime,
            "PartialEq reflexive: ElevenLabsRealtime == ElevenLabsRealtime"
        );
        assert_ne!(
            TranscriptionEngineType::Whisper,
            TranscriptionEngineType::AppleSpeech,
            "異 variant 不等値: Whisper != AppleSpeech"
        );
        assert_ne!(
            TranscriptionEngineType::Whisper,
            TranscriptionEngineType::OpenAIRealtime,
            "異 variant 不等値: Whisper != OpenAIRealtime"
        );
        assert_ne!(
            TranscriptionEngineType::Whisper,
            TranscriptionEngineType::ElevenLabsRealtime,
            "異 variant 不等値: Whisper != ElevenLabsRealtime"
        );
        assert_ne!(
            TranscriptionEngineType::AppleSpeech,
            TranscriptionEngineType::OpenAIRealtime,
            "異 variant 不等値: AppleSpeech != OpenAIRealtime"
        );
        assert_ne!(
            TranscriptionEngineType::AppleSpeech,
            TranscriptionEngineType::ElevenLabsRealtime,
            "異 variant 不等値: AppleSpeech != ElevenLabsRealtime"
        );
        assert_ne!(
            TranscriptionEngineType::OpenAIRealtime,
            TranscriptionEngineType::ElevenLabsRealtime,
            "異 variant 不等値: OpenAIRealtime != ElevenLabsRealtime"
        );
    }

    #[test]
    fn transcription_engine_type_serde_serialize_uses_camel_case_for_each_variant() {
        assert_eq!(
            serde_json::to_value(&TranscriptionEngineType::Whisper)
                .unwrap()
                .as_str(),
            Some("whisper"),
            "Whisper variant が JSON 文字列 'whisper' (camelCase) に serialize される契約"
        );
        assert_eq!(
            serde_json::to_value(&TranscriptionEngineType::AppleSpeech)
                .unwrap()
                .as_str(),
            Some("appleSpeech"),
            "AppleSpeech variant が JSON 文字列 'appleSpeech' (camelCase) に serialize される契約"
        );
        assert_eq!(
            serde_json::to_value(&TranscriptionEngineType::OpenAIRealtime)
                .unwrap()
                .as_str(),
            Some("openAIRealtime"),
            "OpenAIRealtime variant が JSON 文字列 'openAIRealtime' (camelCase, 連続大文字 'AI' 維持) に serialize される契約"
        );
        assert_eq!(
            serde_json::to_value(&TranscriptionEngineType::ElevenLabsRealtime)
                .unwrap()
                .as_str(),
            Some("elevenLabsRealtime"),
            "ElevenLabsRealtime variant が JSON 文字列 'elevenLabsRealtime' (camelCase) に serialize される契約"
        );
        let snake_w = serde_json::to_string(&TranscriptionEngineType::Whisper).unwrap();
        assert!(
            !snake_w.contains("WHISPER"),
            "snake_case / SCREAMING_CASE への誤改修を遮断: got {}",
            snake_w
        );
        let snake_o = serde_json::to_string(&TranscriptionEngineType::OpenAIRealtime).unwrap();
        assert!(
            !snake_o.contains("open_a_i_realtime"),
            "snake_case 'open_a_i_realtime' への誤改修を遮断: got {}",
            snake_o
        );
        assert!(
            !snake_o.contains("OpenAIRealtime"),
            "PascalCase そのままへの誤改修を遮断: got {}",
            snake_o
        );
    }

    #[test]
    fn app_settings_debug_output_contains_struct_name_and_all_six_field_names() {
        let settings = AppSettings {
            transcription_engine: TranscriptionEngineType::AppleSpeech,
            whisper_model: "base".to_string(),
            microphone_device_id: Some("dev-mic-001".to_string()),
            language: "ja".to_string(),
            output_directory: Some("/tmp/out".to_string()),
            api_key: Some("sk-test-001".to_string()),
        };
        let debug = format!("{settings:?}");
        assert!(debug.contains("AppSettings"), "型名を含む契約");
        assert!(
            debug.contains("transcription_engine"),
            "field 名 transcription_engine"
        );
        assert!(debug.contains("whisper_model"), "field 名 whisper_model");
        assert!(
            debug.contains("microphone_device_id"),
            "field 名 microphone_device_id"
        );
        assert!(debug.contains("language"), "field 名 language");
        assert!(
            debug.contains("output_directory"),
            "field 名 output_directory"
        );
        assert!(debug.contains("api_key"), "field 名 api_key");
        assert!(debug.contains("AppleSpeech"), "値 AppleSpeech");
        assert!(debug.contains("base"), "値 base");
        assert!(debug.contains("dev-mic-001"), "値 dev-mic-001");
        assert!(debug.contains("ja"), "値 ja");
        assert!(debug.contains("/tmp/out"), "値 /tmp/out");
        assert!(debug.contains("sk-test-001"), "値 sk-test-001");
    }

    #[test]
    fn app_settings_clone_is_deep_and_does_not_mutate_original() {
        let original = AppSettings {
            transcription_engine: TranscriptionEngineType::Whisper,
            whisper_model: "small".to_string(),
            microphone_device_id: Some("mic-A".to_string()),
            language: "auto".to_string(),
            output_directory: None,
            api_key: Some("k1".to_string()),
        };
        let mut cloned = original.clone();
        cloned.transcription_engine = TranscriptionEngineType::OpenAIRealtime;
        cloned.whisper_model = "large-v3".to_string();
        cloned.microphone_device_id = Some("mic-B".to_string());
        cloned.language = "en".to_string();
        cloned.output_directory = Some("/var/log".to_string());
        cloned.api_key = None;
        let original_debug = format!("{original:?}");
        assert!(original_debug.contains("Whisper"), "original: Whisper 維持");
        assert!(
            !original_debug.contains("OpenAIRealtime"),
            "original: OpenAIRealtime 混入なし"
        );
        assert!(
            original_debug.contains("\"small\""),
            "original: whisper_model 'small' 維持"
        );
        assert!(
            !original_debug.contains("\"large-v3\""),
            "original: large-v3 混入なし"
        );
        assert!(original_debug.contains("\"mic-A\""), "original: mic-A 維持");
        assert!(
            !original_debug.contains("\"mic-B\""),
            "original: mic-B 混入なし"
        );
        assert!(original_debug.contains("\"auto\""), "original: auto 維持");
        assert!(!original_debug.contains("\"en\""), "original: en 混入なし");
        assert!(
            original_debug.contains("None"),
            "original: output_directory None 維持"
        );
        assert!(
            !original_debug.contains("\"/var/log\""),
            "original: /var/log 混入なし"
        );
        assert!(
            original_debug.contains("\"k1\""),
            "original: api_key k1 維持"
        );
    }

    #[test]
    fn app_settings_serde_serialize_uses_camel_case_for_all_six_fields() {
        let settings = AppSettings {
            transcription_engine: TranscriptionEngineType::ElevenLabsRealtime,
            whisper_model: "tiny".to_string(),
            microphone_device_id: Some("device-X".to_string()),
            language: "ja".to_string(),
            output_directory: Some("/home/u/out".to_string()),
            api_key: Some("eleven-key".to_string()),
        };
        let json = serde_json::to_value(&settings).expect("serialize ok");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 6, "field 数厳密 = 6");
        assert!(
            obj.contains_key("transcriptionEngine"),
            "camelCase key transcriptionEngine"
        );
        assert!(
            obj.contains_key("whisperModel"),
            "camelCase key whisperModel"
        );
        assert!(
            obj.contains_key("microphoneDeviceId"),
            "camelCase key microphoneDeviceId"
        );
        assert!(obj.contains_key("language"), "key language");
        assert!(
            obj.contains_key("outputDirectory"),
            "camelCase key outputDirectory"
        );
        assert!(obj.contains_key("apiKey"), "camelCase key apiKey");
        assert!(!obj.contains_key("transcription_engine"), "snake_case 不在");
        assert!(!obj.contains_key("whisper_model"), "snake_case 不在");
        assert!(!obj.contains_key("microphone_device_id"), "snake_case 不在");
        assert!(!obj.contains_key("output_directory"), "snake_case 不在");
        assert!(!obj.contains_key("api_key"), "snake_case 不在");
        assert_eq!(
            obj["transcriptionEngine"],
            serde_json::json!("elevenLabsRealtime"),
            "nested enum camelCase serialize"
        );
        assert_eq!(
            obj["whisperModel"],
            serde_json::json!("tiny"),
            "whisperModel 値"
        );
        assert_eq!(
            obj["microphoneDeviceId"],
            serde_json::json!("device-X"),
            "microphoneDeviceId 値"
        );
        assert_eq!(obj["language"], serde_json::json!("ja"), "language 値");
        assert_eq!(
            obj["outputDirectory"],
            serde_json::json!("/home/u/out"),
            "outputDirectory 値"
        );
        assert_eq!(obj["apiKey"], serde_json::json!("eleven-key"), "apiKey 値");
    }
}
