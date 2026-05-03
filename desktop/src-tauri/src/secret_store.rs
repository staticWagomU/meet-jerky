//! OS のセキュアストア (macOS Keychain / Windows Credential Manager) に
//! API キー等の秘匿情報を保管するためのモジュール。
//!
//! 設計方針:
//! - 平文での保存・送信を避けるため、フロントエンドから API キーが
//!   漏れないようにする。フロントは `set` / `clear` / `has` のみ呼び出し、
//!   実際のキー値は決して JS 側に渡さない。
//! - 非対応プラットフォーム (Linux 等) では明示的なエラーを返す。
//!   このアプリの主対象は macOS なので Linux サポートは持たない。

// Keychain サービス名・アカウント名は macOS / Windows ビルドでのみ参照される。
// 非対応プラットフォームではスタブ実装が呼ばれるので unused warning を抑制する。
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
const SERVICE: &str = "com.wagomu.meet-jerky";

/// Keychain に保存するアカウント名 (キー識別子)。
#[derive(Debug, Clone, Copy)]
pub enum SecretKey {
    OpenAIApiKey,
    ElevenLabsApiKey,
}

impl SecretKey {
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    pub fn account(&self) -> &'static str {
        match self {
            SecretKey::OpenAIApiKey => "openai-api-key",
            SecretKey::ElevenLabsApiKey => "elevenlabs-api-key",
        }
    }
}

// ─────────────────────────────────────────────
// 内部実装 (プラットフォーム別)
// ─────────────────────────────────────────────

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn entry_for(key: SecretKey) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key.account())
        .map_err(|e| format!("Keychain エントリの作成に失敗しました: {e}"))
}

/// 秘密値を保存する。
pub fn set_secret(key: SecretKey, value: &str) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let entry = entry_for(key)?;
        entry
            .set_password(value)
            .map_err(|e| format!("Keychain への保存に失敗しました: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (key, value);
        Err("このプラットフォームでは Keychain がサポートされていません".to_string())
    }
}

/// 秘密値を取得する (存在しなければ Ok(None))。
pub fn get_secret(key: SecretKey) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let entry = entry_for(key)?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Keychain からの読み取りに失敗しました: {e}")),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = key;
        Err("このプラットフォームでは Keychain がサポートされていません".to_string())
    }
}

/// 秘密値を削除する。存在しなくてもエラーにしない。
pub fn delete_secret(key: SecretKey) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let entry = entry_for(key)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain の削除に失敗しました: {e}")),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = key;
        Err("このプラットフォームでは Keychain がサポートされていません".to_string())
    }
}

/// 秘密値が存在するか確認する。値そのものは返さない (フロントに漏らさないため)。
pub fn has_secret(key: SecretKey) -> Result<bool, String> {
    Ok(get_secret(key)?.is_some())
}

// ─────────────────────────────────────────────
// Tauri コマンド
// ─────────────────────────────────────────────
//
// フロントエンドから呼び出される。値そのものは Tauri 経由で行き来しない
// (`get_*` 系コマンドを設けない) ので、JS 側のコンソールやログから
// API キーが漏洩する経路を遮断する。

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
    fn secret_key_account_is_stable() {
        // Keychain のキー識別子を不用意に変えると、ユーザーが再入力を
        // 強いられる。アカウント名を回帰防止で固定する。
        assert_eq!(SecretKey::OpenAIApiKey.account(), "openai-api-key");
        assert_eq!(SecretKey::ElevenLabsApiKey.account(), "elevenlabs-api-key");
    }

    #[test]
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn secret_apis_error_clearly_on_unsupported_platforms() {
        // Linux 等のビルドが通ることと、誤って呼び出された場合に
        // 分かりやすいエラーが出ることを保証する。
        let err = set_secret(SecretKey::OpenAIApiKey, "x").unwrap_err();
        assert!(err.contains("プラットフォーム"));
        let err = get_secret(SecretKey::OpenAIApiKey).unwrap_err();
        assert!(err.contains("プラットフォーム"));
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
    fn secret_key_accounts_are_distinct() {
        // copy-paste による account 文字列の衝突を検知する。
        // secret_key_account_is_stable は絶対値を固定するが「両者が異なる」
        // 不変条件は明示していないため、このテストで補完する。
        assert_ne!(
            SecretKey::OpenAIApiKey.account(),
            SecretKey::ElevenLabsApiKey.account()
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
