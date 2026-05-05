//! API キー (OpenAI / ElevenLabs) を OS のセキュアストアに保存・削除・存在確認する tauri コマンド群。
//!
//! `secret_store.rs` 本来責務 (Keychain 内部実装 + SecretKey 識別子 + 共通 set/get/delete/has helper)
//! から tauri 公開 API 軸を切り出して機能境界で分離する。
//! フロントエンドからの呼び出し経路 (invoke handler) は変わらない。

use crate::secret_store::{delete_secret, has_secret, set_secret, SecretKey};

/// OpenAI API キーを Keychain に保存する。
///
/// 空文字列または前後空白のみの値はバリデーション失敗とし、保存しない。
#[tauri::command]
pub fn set_openai_api_key(api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API キーが空です".to_string());
    }
    set_secret(SecretKey::OpenAIApiKey, trimmed)
}

/// OpenAI API キーを Keychain から削除する。
#[tauri::command]
pub fn clear_openai_api_key() -> Result<(), String> {
    delete_secret(SecretKey::OpenAIApiKey)
}

/// OpenAI API キーが Keychain に保存されているかを返す。値自体は返さない。
#[tauri::command]
pub fn has_openai_api_key() -> Result<bool, String> {
    has_secret(SecretKey::OpenAIApiKey)
}

/// ElevenLabs API キーを Keychain に保存する。
///
/// 空文字列または前後空白のみの値はバリデーション失敗とし、保存しない。
#[tauri::command]
pub fn set_elevenlabs_api_key(api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API キーが空です".to_string());
    }
    set_secret(SecretKey::ElevenLabsApiKey, trimmed)
}

/// ElevenLabs API キーを Keychain から削除する。
#[tauri::command]
pub fn clear_elevenlabs_api_key() -> Result<(), String> {
    delete_secret(SecretKey::ElevenLabsApiKey)
}

/// ElevenLabs API キーが Keychain に保存されているかを返す。値自体は返さない。
#[tauri::command]
pub fn has_elevenlabs_api_key() -> Result<bool, String> {
    has_secret(SecretKey::ElevenLabsApiKey)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_openai_api_key_rejects_empty_input() {
        // 空文字列・空白のみは Keychain に到達する前にバリデーションで弾く
        assert!(set_openai_api_key(String::new()).is_err());
        assert!(set_openai_api_key("   ".to_string()).is_err());
    }

    #[test]
    fn set_elevenlabs_api_key_rejects_empty_input() {
        // ElevenLabs も OpenAI と同じ境界で空入力を弾き、Keychain に到達させない。
        assert!(set_elevenlabs_api_key(String::new()).is_err());
        assert!(set_elevenlabs_api_key("   ".to_string()).is_err());
    }

    #[test]
    fn set_api_keys_return_consistent_japanese_message_for_empty_input() {
        // 既存テストは is_err() のみ。UI 表示文言が壊れても気付けないため、
        // 文言完全一致の契約強制で UI 体験を保護する。
        assert_eq!(
            set_openai_api_key(String::new()).unwrap_err(),
            "API キーが空です"
        );
        assert_eq!(
            set_elevenlabs_api_key(String::new()).unwrap_err(),
            "API キーが空です"
        );
        // 両 API の文言が同一であること (体験統一性の不変条件)
        assert_eq!(
            set_openai_api_key(String::new()).unwrap_err(),
            set_elevenlabs_api_key(String::new()).unwrap_err()
        );
    }

    #[test]
    fn set_api_keys_treat_various_whitespace_chars_as_empty() {
        // 既存テストは半角空白のみ確認。trim() の仕様変更で tab/newline が
        // 素通りするリグレッションを検知するため多様な whitespace で裏付ける。
        assert!(set_openai_api_key("\t".to_string()).is_err());
        assert!(set_openai_api_key("\n".to_string()).is_err());
        assert!(set_openai_api_key("\t\n  ".to_string()).is_err());
        assert!(set_openai_api_key("  \t \n ".to_string()).is_err());
        assert!(set_elevenlabs_api_key("\t".to_string()).is_err());
        assert!(set_elevenlabs_api_key("\n".to_string()).is_err());
        assert!(set_elevenlabs_api_key("\t\n  ".to_string()).is_err());
        assert!(set_elevenlabs_api_key("  \t \n ".to_string()).is_err());
    }
}
