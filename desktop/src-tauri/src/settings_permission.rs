//! macOS のマイク / 画面録画パーミッション状態を取得する tauri command と
//! `permission_status_to_string` ヘルパを提供する。`settings.rs` 本体の
//! `AppSettings` 永続化責務とは独立しているため、機能境界で分離する。

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
        permission_status_to_string(macos_permissions::microphone_permission_status())
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
        permission_status_to_string(macos_permissions::screen_recording_permission_status())
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn permission_status_to_string_returns_denied_for_negative_values_as_fail_safe() {
        // 既存 l.295 (test_permission_status_to_string_maps_known_values) は known 3 値 + unknown 99 のみ。
        // 負値は match の `_ => "denied"` で受けられる。誤って許可を付与しないための fail-safe 契約 (#9 透明性)。
        // 「`_ => "granted"` に変える誤改修」「負値専用ブランチを追加して別文字列を返す誤改修」を遮断する装置。
        assert_eq!(
            permission_status_to_string(-1),
            "denied",
            "負値 -1 は fail-safe で 'denied' に倒す現契約。permission ダイアログで誤って granted を返さない安全性を CI 固定。"
        );
        assert_eq!(
            permission_status_to_string(i32::MIN),
            "denied",
            "i32::MIN (極端な負値) も fail-safe で 'denied' に倒す現契約。overflow ガードなしの match で `_` で受ける挙動を CI 固定。"
        );
    }

    #[test]
    fn permission_status_to_string_returns_denied_for_value_adjacent_to_granted_as_fail_safe() {
        // PERMISSION_GRANTED = 2 の +1 隣接値 (3) が unknown であることを CI 固定。
        // OS 側の API が将来「PERMISSION_PROVISIONAL = 3」等の新値を返した場合に
        // 「明示的に新値の意味を考えてから対応する」ことを強制する装置 (silent な誤分類を防ぐ)。
        // 「3 を granted 扱いする誤改修」を遮断する。
        assert_eq!(
            permission_status_to_string(3),
            "denied",
            "PERMISSION_GRANTED (=2) 直後の 3 は unknown として 'denied' に倒す現契約。OS 側の新値追加に silent に追従しないための fail-safe を CI 固定。"
        );
    }

    #[test]
    fn permission_status_to_string_returns_denied_for_i32_max_as_fail_safe() {
        // i32::MAX (2147483647) も match `_` で受ける fail-safe 動作を CI 固定。
        // 過去 mjc-main-24 (current_started_at_secs u64::MAX 保護) と同種の「型上限境界での truncation/overflow ガード」軸。
        // 「i32::MAX を特別扱いする (panic 等) 誤改修」を遮断する装置。
        assert_eq!(
            permission_status_to_string(i32::MAX),
            "denied",
            "i32::MAX (型上限) も fail-safe で 'denied' に倒す現契約。型境界で panic/overflow しない安全性を CI 固定。"
        );
    }
}
