//! 会議アプリ検知時の OS 通知 (banner) を発火する helper。
//!
//! `app_detection.rs` 本体の `handle_detection` / `handle_browser_url_detection` /
//! `check_all_inactive_bundles` から呼ばれる。AppHandle 依存の `show_*` と
//! 純粋関数 `*_body` で構成される。

use tauri::AppHandle;

pub(crate) fn show_notification(app: &AppHandle, app_name: &str) {
    use tauri_plugin_notification::NotificationExt;

    let title = "Meet Jerky";
    let body = notification_body(app_name);

    if let Err(e) = app.notification().builder().title(title).body(&body).show() {
        eprintln!("[app_detection] notification show failed: {e}");
    }
}

/// 会議アプリが long time 検知されていない場合の inactive 通知を発火する。
/// `show_notification` と同じ Tauri Notification API を使い、本文だけ
/// `inactive_notification_body` で生成する別 body にする。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn show_inactive_notification(app: &AppHandle, app_name: &str, elapsed_secs: u64) {
    use tauri_plugin_notification::NotificationExt;

    let title = "Meet Jerky";
    let body = inactive_notification_body(app_name, elapsed_secs);

    if let Err(e) = app.notification().builder().title(title).body(&body).show() {
        eprintln!("[app_detection] inactive notification show failed: {e}");
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn notification_body(app_name: &str) -> String {
    format!(
        "{app_name} を検出しました。自分/相手側トラックの録音と文字起こしの状態をアプリで確認してください。"
    )
}

/// inactive 通知の本文を生成する純粋関数。
/// app_name と elapsed_secs を受け取って表示文を整形する。test 容易性のため `show_inactive_notification` から分離。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn inactive_notification_body(app_name: &str, elapsed_secs: u64) -> String {
    let elapsed_min = elapsed_secs / 60;
    format!(
        "{app_name} が {elapsed_min} 分以上検知されていません。会議が終了している場合は録音と文字起こしを停止してください。"
    )
}

#[cfg(test)]
mod tests {
    use super::{inactive_notification_body, notification_body};

    #[test]
    fn notification_body_does_not_claim_click_starts_recording() {
        let body = notification_body("Zoom");
        assert!(body.contains("Zoom を検出しました。"));
        assert!(
            !body.contains("クリックで記録を開始"),
            "通知クリックで録音開始する未実装挙動を本文に含めない"
        );
        assert!(
            !body.contains("まだ開始していません"),
            "録音中に再検知される可能性があるため未開始と断定しない"
        );
        assert!(body.contains("自分/相手側トラックの録音と文字起こしの状態"));
    }

    #[test]
    fn inactive_notification_body_includes_app_name_and_elapsed_minutes() {
        // 通知文が「<app_name> が <分数> 分以上検知されていません」を含む契約を固定。
        // app_name と分数の両方が body に embed される設計を CI で検知。
        let body = inactive_notification_body("Zoom", 720); // 720 秒 = 12 分
        assert!(
            body.contains("Zoom"),
            "body should contain app_name: {body}"
        );
        assert!(
            body.contains("12"),
            "body should contain elapsed_min: {body}"
        );
    }

    #[test]
    fn inactive_notification_body_truncates_seconds_to_minutes() {
        // 600 秒 = 10 分、659 秒 = 10 分 (整数除算で truncate される契約)、660 秒 = 11 分。
        // 整数除算で minutes に丸める設計を CI で検知。
        assert!(inactive_notification_body("X", 600).contains("10"));
        assert!(inactive_notification_body("X", 659).contains("10"));
        assert!(inactive_notification_body("X", 660).contains("11"));
    }
}
