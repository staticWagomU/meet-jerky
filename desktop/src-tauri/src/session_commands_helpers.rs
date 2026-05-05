//! `session_commands.rs` から純粋関数 helpers (now_unix_secs / default_offset
//! / resolve_output_directory) を切り出した module。
//!
//! caller は `session_commands.rs` の start/finalize 系と
//! `session_commands_list.rs` の `list_sessions`。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::FixedOffset;

use crate::settings::{default_output_directory, SettingsStateHandle};

/// 現在時刻 (unix 秒) を取得。`SystemTime::now` の逆行時は 0 を返すが、
/// 実用上ここに来るケースは無い。
pub(crate) fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Phase 5 時点で採用する表示タイムゾーン (JST 固定)。
///
/// 将来ユーザー設定化する際はここを差し替えれば良い。
pub(crate) fn default_offset() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).expect("JST offset is always valid")
}

/// 設定から出力ディレクトリを解決する。未設定 or 空文字の場合は
/// アプリ既定ディレクトリを使う。
pub(crate) fn resolve_output_directory(settings_state: &SettingsStateHandle) -> PathBuf {
    let settings = settings_state.0.lock();
    match settings.output_directory.as_deref() {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => default_output_directory(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn build_settings_handle_with_dir(dir: Option<String>) -> SettingsStateHandle {
        use crate::settings::AppSettings;
        use parking_lot::Mutex;
        SettingsStateHandle(Mutex::new(AppSettings {
            output_directory: dir,
            ..AppSettings::default()
        }))
    }

    #[test]
    fn resolve_output_directory_returns_default_when_setting_is_none() {
        let handle = build_settings_handle_with_dir(None);
        let result = resolve_output_directory(&handle);
        assert_eq!(result, default_output_directory());
    }

    #[test]
    fn resolve_output_directory_returns_default_when_setting_is_empty() {
        let handle = build_settings_handle_with_dir(Some(String::new()));
        let result = resolve_output_directory(&handle);
        assert_eq!(result, default_output_directory());
    }

    #[test]
    fn resolve_output_directory_returns_setting_path_when_set_to_nonempty() {
        let handle = build_settings_handle_with_dir(Some("/tmp/custom-output".into()));
        let result = resolve_output_directory(&handle);
        assert_eq!(result, PathBuf::from("/tmp/custom-output"));
        assert_ne!(result, default_output_directory());
    }

    #[test]
    fn resolve_output_directory_does_not_trim_whitespace_in_setting_path() {
        let handle = build_settings_handle_with_dir(Some(" /tmp/path ".into()));
        let result = resolve_output_directory(&handle);
        assert_eq!(result, PathBuf::from(" /tmp/path "));
    }

    #[test]
    fn default_offset_returns_jst_offset_constant() {
        let offset = default_offset();
        assert_eq!(offset, FixedOffset::east_opt(9 * 3600).unwrap());
        assert_eq!(offset.local_minus_utc(), 9 * 3600);
    }
}
