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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn secret_key_debug_output_uses_variant_name_without_leaking_account_string() {
        // Debug 出力は variant 名のみで構成され、account 文字列を含まない現契約を固定する。
        // 将来「Debug を手動実装に切替えて account 値を含めてしまう誤改修」「panic 時の
        // ログに機密文字列が漏れる誤改修」を遮断する装置。
        let openai_dbg = format!("{:?}", SecretKey::OpenAIApiKey);
        let elevenlabs_dbg = format!("{:?}", SecretKey::ElevenLabsApiKey);
        assert!(
            openai_dbg.contains("OpenAIApiKey"),
            "Debug 出力に variant 名がない: {openai_dbg}"
        );
        assert!(
            elevenlabs_dbg.contains("ElevenLabsApiKey"),
            "Debug 出力に variant 名がない: {elevenlabs_dbg}"
        );
        assert!(
            !openai_dbg.contains("openai-api-key"),
            "Debug 出力に account 文字列が漏出: {openai_dbg}"
        );
        assert!(
            !elevenlabs_dbg.contains("elevenlabs-api-key"),
            "Debug 出力に account 文字列が漏出: {elevenlabs_dbg}"
        );
    }

    #[test]
    fn secret_key_implements_copy_trait_so_value_remains_usable_after_assignment() {
        // SecretKey は #[derive(Copy)] により値型として扱える現契約を固定する。
        // 将来「Copy を消して move semantics に変える誤改修」が起きると、呼び出し元
        // (entry_for(key) と key.account() の順次使用) で borrow checker error が
        // 発生し API 表面が壊れるため遮断装置として機能する。
        let key = SecretKey::OpenAIApiKey;
        let copied = key; // Copy で move されない
        assert_eq!(
            copied.account(),
            "openai-api-key",
            "Copy 後の値が元と異なる"
        );
        assert_eq!(
            key.account(),
            "openai-api-key",
            "元の値が move されて使えなくなった"
        );
    }

    #[test]
    fn secret_key_account_strings_use_lowercase_kebab_case_format_for_all_variants() {
        // account 文字列の format 規則 (lowercase kebab-case) を全 variant で固定する。
        // 既存 secret_key_account_is_stable は絶対値を固定するが、format 規則は
        // 明示していないため、将来 variant 追加時の命名一貫性を保証する装置として補完。
        for key in [SecretKey::OpenAIApiKey, SecretKey::ElevenLabsApiKey] {
            let account = key.account();
            assert!(!account.is_empty(), "account 文字列が空: {account}");
            assert!(
                account.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "account に小文字・ハイフン以外の文字を含む: {account}"
            );
            assert!(
                account.contains('-'),
                "kebab-case 区切りのハイフンがない: {account}"
            );
            assert!(!account.starts_with('-'), "ハイフンで開始: {account}");
            assert!(!account.ends_with('-'), "ハイフンで終了: {account}");
        }
    }
}
