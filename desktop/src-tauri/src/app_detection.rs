//! Zoom / Microsoft Teams 等の会議アプリ起動・起動済み状態を検知して、ユーザーに
//! 記録開始の確認を促す通知 + フロントエンドへのイベント通知を行う。
//!
//! macOS 限定。`swift/AppDetectionBridge.swift` 経由で `NSWorkspace` を
//! 監視する。
//!
//! 通知のフロー:
//! 1. アプリ起動時に `start()` を呼ぶ → Swift 側 `NSWorkspace` Observer 登録 + 初回スキャン
//! 2. 対象アプリが起動中、または起動する → Swift コールバックが Rust に上がる
//! 3. Rust 側で:
//!    - スロットリング (同一 bundle は 60 秒以内に再通知しない)
//!    - macOS 通知センターに通知を出す
//!    - フロントエンドへ `meeting-app-detected` イベントを emit
//! 4. フロントエンドがバナーを表示し、ユーザーがアプリ側で記録開始を確認する

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// 以下の定数・関数は macOS の Swift bridge から呼ばれる。
// Linux 等のビルドで dead_code 警告にならないように cfg_attr で抑制する。

/// 検知対象の Bundle ID 一覧。新しい会議アプリが増えたらここに追加する。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const WATCHED_BUNDLE_IDS: &[(&str, &str)] = &[
    ("us.zoom.xos", "Zoom"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    // 旧 Teams (legacy, Electron 版)。新版に切り替わっても誤検知にはならないため両方監視。
    ("com.microsoft.teams", "Microsoft Teams"),
    // FaceTime 等を将来追加するならここに足す。
];

/// 同一アプリの再通知を抑制する間隔。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const NOTIFICATION_THROTTLE: Duration = Duration::from_secs(60);

/// フロントエンドに送る通知ペイロード (Tauri event)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MeetingAppDetectedPayload {
    pub bundle_id: String,
    pub app_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
}

/// ブラウザ URL から会議サービスを分類した結果。
///
/// URL 全文や path は保持しない。フロントエンド表示・ログ用に必要な
/// service 表示名と host だけを返す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingUrlClassification {
    pub service: String,
    pub host: String,
}

/// 検知のグローバル状態。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct DetectionState {
    app_handle: AppHandle,
    last_seen: Mutex<HashMap<String, Instant>>,
}

static STATE: OnceLock<DetectionState> = OnceLock::new();

/// 検知を開始する。アプリ起動時に 1 度だけ呼ぶ。
///
/// macOS 以外では何もしない (静かに無視)。
pub fn start(app_handle: AppHandle) {
    // 二重初期化のときは Swift bridge も呼ばない (Observer が二重登録される)。
    let first_time = STATE
        .set(DetectionState {
            app_handle,
            last_seen: Mutex::new(HashMap::new()),
        })
        .is_ok();

    if first_time {
        #[cfg(target_os = "macos")]
        macos::start_detection();
    }
}

/// Swift 側コールバックから呼ばれる共通ハンドラ。
///
/// スロットリング → 通知表示 → Tauri イベント emit の順に処理する。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn handle_detection(bundle_id: &str, app_name: &str) {
    let state = match STATE.get() {
        Some(s) => s,
        None => return,
    };

    // スロットリングチェック (同一 bundle が連続で起動するシナリオで通知を絞る)
    {
        let mut last_seen = state.last_seen.lock();
        let now = Instant::now();
        if let Some(prev) = last_seen.get(bundle_id) {
            if now.duration_since(*prev) < NOTIFICATION_THROTTLE {
                return;
            }
        }
        last_seen.insert(bundle_id.to_string(), now);
    }

    // 通知センターに通知を出す
    show_notification(&state.app_handle, app_name);

    // フロントエンド (バナー表示・記録開始導線) へイベントを通知
    let payload = MeetingAppDetectedPayload {
        bundle_id: bundle_id.to_string(),
        app_name: app_name.to_string(),
        source: Some("app".to_string()),
        service: None,
        url_host: None,
        browser_name: None,
        window_title: None,
    };
    if let Err(e) = state.app_handle.emit("meeting-app-detected", &payload) {
        eprintln!("[app_detection] emit failed: {e}");
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn show_notification(app: &AppHandle, app_name: &str) {
    use tauri_plugin_notification::NotificationExt;

    let title = "Meet Jerky";
    let body = notification_body(app_name);

    if let Err(e) = app.notification().builder().title(title).body(&body).show() {
        eprintln!("[app_detection] notification show failed: {e}");
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn notification_body(app_name: &str) -> String {
    format!("{app_name} を検出しました。記録を開始するにはアプリで確認してください。")
}

/// ブラウザ URL の実機取得が入った後に使う、会議 URL 分類用の純粋関数。
///
/// 標準文字列処理だけで host/path を見て分類し、URL 全文は返さない。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn classify_meeting_url(url: &str) -> Option<MeetingUrlClassification> {
    let parsed = parse_url_host_and_path(url)?;
    let host = parsed.host.to_ascii_lowercase();

    let service = if host == "meet.google.com" {
        "Google Meet"
    } else if is_zoom_meeting_url(&host, &parsed.path) {
        "Zoom"
    } else if is_teams_meeting_url(&host, &parsed.path) {
        "Microsoft Teams"
    } else {
        return None;
    };

    Some(MeetingUrlClassification {
        service: service.to_string(),
        host,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedUrlParts {
    host: String,
    path: String,
}

fn parse_url_host_and_path(url: &str) -> Option<ParsedUrlParts> {
    let trimmed = url.trim();
    let (scheme, after_scheme) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }

    let authority_end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = strip_port(host_port)?;
    if host.is_empty() {
        return None;
    }

    let path =
        if authority_end < after_scheme.len() && after_scheme[authority_end..].starts_with('/') {
            let rest = &after_scheme[authority_end..];
            let path_end = rest.find(|c| c == '?' || c == '#').unwrap_or(rest.len());
            rest[..path_end].to_string()
        } else {
            "/".to_string()
        };

    Some(ParsedUrlParts {
        host: host.to_string(),
        path,
    })
}

fn strip_port(host_port: &str) -> Option<&str> {
    if let Some(without_opening_bracket) = host_port.strip_prefix('[') {
        let (host, _) = without_opening_bracket.split_once(']')?;
        return Some(host);
    }
    Some(
        host_port
            .split_once(':')
            .map_or(host_port, |(host, _)| host),
    )
}

fn is_zoom_host(host: &str) -> bool {
    host == "zoom.us" || host.ends_with(".zoom.us")
}

fn is_zoom_meeting_url(host: &str, path: &str) -> bool {
    is_zoom_host(host) && (path.starts_with("/j/") || path.starts_with("/wc/join/"))
}

fn is_teams_meeting_url(host: &str, path: &str) -> bool {
    (host == "teams.microsoft.com" && path.starts_with("/l/meetup-join/"))
        || (host == "teams.live.com" && path.starts_with("/meet/"))
}

// ─────────────────────────────────────────────
// macOS 固有の実装 (Swift bridge 呼び出し)
// ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void, CStr, CString};

    use super::{handle_detection, WATCHED_BUNDLE_IDS};

    type DetectionCallback =
        extern "C" fn(bundle_id: *const c_char, app_name: *const c_char, user_data: *mut c_void);

    extern "C" {
        fn meet_jerky_app_detection_start(
            bundle_ids_json: *const c_char,
            callback: DetectionCallback,
            user_data: *mut c_void,
        ) -> i32;

        #[allow(dead_code)]
        fn meet_jerky_app_detection_stop();
    }

    extern "C" fn detection_callback(
        bundle_id: *const c_char,
        app_name: *const c_char,
        _user_data: *mut c_void,
    ) {
        if bundle_id.is_null() || app_name.is_null() {
            return;
        }
        // Safety: Swift 側でコールバック呼び出しの間だけ valid な C 文字列。
        // ここでスコープを抜ける前に String にコピーする。
        let bundle = unsafe { CStr::from_ptr(bundle_id) }
            .to_string_lossy()
            .into_owned();
        let name = unsafe { CStr::from_ptr(app_name) }
            .to_string_lossy()
            .into_owned();

        // 通知発火・イベント emit は別スレッドで実行する。
        // NSWorkspace コールバックは main thread で呼ばれるので、
        // tauri-plugin-notification 等の重い処理を直接呼ぶと UI 描画を
        // ブロックする可能性がある。
        std::thread::spawn(move || {
            handle_detection(&bundle, &name);
        });
    }

    pub fn start_detection() {
        // 監視対象を JSON 配列にして Swift に渡す
        let bundle_ids: Vec<&str> = WATCHED_BUNDLE_IDS.iter().map(|(id, _)| *id).collect();
        let json = serde_json::to_string(&bundle_ids).expect("static ID array should serialize");
        let c_json = match CString::new(json) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[app_detection] CString conversion failed: {e}");
                return;
            }
        };

        // Safety: c_json は呼び出し中ずっと生存する。コールバックは static fn。
        let rc = unsafe {
            meet_jerky_app_detection_start(
                c_json.as_ptr(),
                detection_callback,
                std::ptr::null_mut(),
            )
        };
        if rc != 0 {
            eprintln!("[app_detection] start returned rc={rc}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watched_bundle_ids_includes_zoom_and_teams() {
        // 監視対象が抜け落ちないように回帰防止する
        let ids: Vec<&str> = WATCHED_BUNDLE_IDS.iter().map(|(id, _)| *id).collect();
        assert!(
            ids.contains(&"us.zoom.xos"),
            "Zoom Bundle ID が抜けています"
        );
        assert!(
            ids.contains(&"com.microsoft.teams2") || ids.contains(&"com.microsoft.teams"),
            "Teams Bundle ID (新旧どちらか) が抜けています"
        );
    }

    #[test]
    fn meeting_app_detected_payload_serializes_camel_case() {
        // フロントエンドの型定義 (camelCase) と整合する形でシリアライズされること
        let payload = MeetingAppDetectedPayload {
            bundle_id: "us.zoom.xos".to_string(),
            app_name: "Zoom".to_string(),
            source: Some("app".to_string()),
            service: None,
            url_host: None,
            browser_name: None,
            window_title: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"bundleId\":\"us.zoom.xos\""));
        assert!(json.contains("\"appName\":\"Zoom\""));
        assert!(json.contains("\"source\":\"app\""));
        assert!(!json.contains("urlHost"));
        assert!(!json.contains("bundle_id"));
    }

    #[test]
    fn notification_body_does_not_claim_click_starts_recording() {
        let body = notification_body("Zoom");
        assert!(body.contains("Zoom を検出しました。"));
        assert!(
            !body.contains("クリックで記録を開始"),
            "通知クリックで録音開始する未実装挙動を本文に含めない"
        );
    }

    #[test]
    fn classify_meeting_url_returns_service_and_host_only() {
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("http://meet.google.com/abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://company.zoom.us/j/123456789?pwd=secret"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "company.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://zoom.us/wc/join/123456789"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://company.zoom.us/wc/join/123456789"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "company.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/l/meetup-join/secret"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.live.com/meet/1234567890123"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.live.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_rejects_non_meeting_or_non_join_urls() {
        assert_eq!(classify_meeting_url("https://zoom.us/profile"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/wc/profile"), None);
        assert_eq!(classify_meeting_url("https://evilzoom.us/j/123"), None);
        assert_eq!(classify_meeting_url("https://example.com/j/123"), None);
        assert_eq!(classify_meeting_url("https://teams.microsoft.com/"), None);
        assert_eq!(classify_meeting_url("https://teams.microsoft.com/_"), None);
        assert_eq!(classify_meeting_url("https://teams.live.com/free"), None);
    }

    #[test]
    fn classify_meeting_url_rejects_non_http_urls() {
        assert_eq!(classify_meeting_url("meet.google.com/abc-defg-hij"), None);
        assert_eq!(
            classify_meeting_url("file://meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("mailto:https://meet.google.com/abc-defg-hij"),
            None
        );
    }
}
