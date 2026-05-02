//! Zoom / Microsoft Teams 等の会議アプリ起動・起動済み状態と、
//! Safari / Chrome / Edge / Brave / Arc / Firefox の会議 URL を検知して、ユーザーに
//! 録音と文字起こしの状態確認を促す通知 + フロントエンドへのイベント通知を行う。
//!
//! macOS 限定。`swift/AppDetectionBridge.swift` 経由で `NSWorkspace` を
//! 監視し、ブラウザのアクティブタブ URL を取得する。
//!
//! 通知のフロー:
//! 1. アプリ起動時に `start()` を呼ぶ → Swift 側 `NSWorkspace` Observer 登録 + 初回スキャン
//! 2. 対象アプリが起動中、または起動する → Swift コールバックが Rust に上がる
//! 3. ブラウザが前面にある場合は Swift がアクティブタブ URL を取得し、
//!    Rust 側の純粋関数で会議 URL だけを分類する
//! 4. Rust 側で:
//!    - スロットリング (同一 bundle は 60 秒以内に再通知しない)
//!    - 専用 prompt window を上部中央へ表示し、アプリ内プロンプトを見せる
//!    - macOS 通知センターに通知を出す
//!    - フロントエンドへ `meeting-app-detected` イベントを emit
//! 5. フロントエンドがバナーを表示し、ユーザーがアプリ側で録音と文字起こしの状態を確認する

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
    ("com.apple.FaceTime", "FaceTime"),
];

/// 同一アプリの再通知を抑制する間隔。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const NOTIFICATION_THROTTLE: Duration = Duration::from_secs(60);

/// フロントエンドに送る通知ペイロード (Tauri event)。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "source")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum MeetingAppDetectedPayload {
    #[serde(rename = "app")]
    App {
        #[serde(rename = "bundleId")]
        bundle_id: String,
        #[serde(rename = "appName")]
        app_name: String,
    },
    #[serde(rename = "browser")]
    Browser {
        #[serde(rename = "bundleId")]
        bundle_id: String,
        #[serde(rename = "appName")]
        app_name: String,
        service: String,
        #[serde(rename = "urlHost")]
        url_host: String,
        #[serde(rename = "browserName")]
        browser_name: String,
    },
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
/// スロットリング → 通知表示 → Tauri イベント emit → prompt 表示の順に処理する。
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

    // フロントエンド (バナー表示・録音/文字起こし状態確認導線) へイベントを通知
    let payload = MeetingAppDetectedPayload::App {
        bundle_id: bundle_id.to_string(),
        app_name: app_name.to_string(),
    };
    match state.app_handle.emit("meeting-app-detected", &payload) {
        Ok(()) => {
            // Payload がフロントへ渡ってから表示し、空の overlay だけが見える瞬間を避ける。
            crate::show_meeting_prompt_window(&state.app_handle);
        }
        Err(e) => {
            eprintln!("[app_detection] emit failed: {e}");
        }
    }
}

/// Swift 側からブラウザのアクティブタブ URL が上がってきたときのハンドラ。
///
/// URL 全文はここで分類にのみ使い、payload / 通知 / log には出さない。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn handle_browser_url_detection(
    bundle_id: &str,
    browser_name: &str,
    url: &str,
    _window_title: &str,
) {
    let Some(classification) = classify_meeting_url(url) else {
        return;
    };

    let state = match STATE.get() {
        Some(s) => s,
        None => return,
    };

    let throttle_key = format!(
        "browser:{bundle_id}:{}:{}",
        classification.service, classification.host
    );
    {
        let mut last_seen = state.last_seen.lock();
        let now = Instant::now();
        if let Some(prev) = last_seen.get(&throttle_key) {
            if now.duration_since(*prev) < NOTIFICATION_THROTTLE {
                return;
            }
        }
        last_seen.insert(throttle_key, now);
    }

    show_notification(&state.app_handle, &classification.service);

    let payload = MeetingAppDetectedPayload::Browser {
        bundle_id: bundle_id.to_string(),
        app_name: browser_name.to_string(),
        service: classification.service,
        url_host: classification.host,
        browser_name: browser_name.to_string(),
    };
    match state.app_handle.emit("meeting-app-detected", &payload) {
        Ok(()) => {
            crate::show_meeting_prompt_window(&state.app_handle);
        }
        Err(e) => {
            eprintln!("[app_detection] browser emit failed: {e}");
        }
    }
}

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
    format!(
        "{app_name} を検出しました。自分/相手側トラックの録音と文字起こしの状態をアプリで確認してください。"
    )
}

/// ブラウザ URL の実機取得が入った後に使う、会議 URL 分類用の純粋関数。
///
/// 標準文字列処理だけで host/path/query を見て分類し、URL 全文は返さない。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn classify_meeting_url(url: &str) -> Option<MeetingUrlClassification> {
    let parsed = parse_url_host_and_path(url)?;
    let host = normalize_url_host(&parsed.host)?;

    let service = if is_google_meet_url(&host, &parsed.path) {
        "Google Meet"
    } else if is_zoom_meeting_url(&host, &parsed.path) {
        "Zoom"
    } else if is_teams_meeting_url(&host, &parsed.path, parsed.query.as_deref()) {
        "Microsoft Teams"
    } else {
        return None;
    };

    Some(MeetingUrlClassification {
        service: service.to_string(),
        host,
    })
}

fn normalize_url_host(host: &str) -> Option<String> {
    let normalized = host.to_ascii_lowercase();
    let normalized = normalized.strip_suffix('.').unwrap_or(&normalized);
    if normalized.is_empty() || normalized.ends_with('.') {
        return None;
    }
    Some(normalized.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedUrlParts {
    host: String,
    path: String,
    query: Option<String>,
}

fn parse_url_host_and_path(url: &str) -> Option<ParsedUrlParts> {
    let trimmed = url.trim();
    if trimmed.chars().any(char::is_whitespace) {
        return None;
    }

    let (scheme, after_scheme) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }

    let authority_end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.contains('@') {
        return None;
    }
    let host_port = authority;
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
    let query = extract_query(&after_scheme[authority_end..]);

    Some(ParsedUrlParts {
        host: host.to_string(),
        path,
        query,
    })
}

fn extract_query(rest: &str) -> Option<String> {
    let query_start = rest.find('?')?;
    if let Some(fragment_start) = rest.find('#') {
        if fragment_start < query_start {
            return None;
        }
    }
    let query = &rest[query_start + 1..];
    let query_end = query.find('#').unwrap_or(query.len());
    Some(query[..query_end].to_string())
}

fn strip_port(host_port: &str) -> Option<&str> {
    if let Some(without_opening_bracket) = host_port.strip_prefix('[') {
        let (host, port) = without_opening_bracket.split_once(']')?;
        if !host.contains(':') {
            return None;
        }
        if let Some(port) = port.strip_prefix(':') {
            validate_port(port)?;
        } else if !port.is_empty() {
            return None;
        }
        return Some(host);
    }

    if let Some((host, port)) = host_port.split_once(':') {
        validate_port(port)?;
        Some(host)
    } else {
        Some(host_port)
    }
}

fn validate_port(port: &str) -> Option<()> {
    if port.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    Some(())
}

fn is_zoom_host(host: &str) -> bool {
    if host == "zoom.us" || host == "zoomgov.com" {
        return true;
    }

    let subdomain = if let Some(subdomain) = host.strip_suffix(".zoom.us") {
        subdomain
    } else if let Some(subdomain) = host.strip_suffix(".zoomgov.com") {
        subdomain
    } else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

fn is_valid_dns_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        && bytes
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
}

fn is_google_meet_url(host: &str, path: &str) -> bool {
    host == "meet.google.com"
        && (is_google_meet_code_path(path)
            || path
                .strip_prefix("/lookup/")
                .is_some_and(has_single_non_empty_segment))
}

fn is_google_meet_code_path(path: &str) -> bool {
    let Some(code) = path.strip_prefix('/') else {
        return false;
    };
    let code = code.strip_suffix('/').unwrap_or(code);

    let mut parts = code.split('-');
    let (Some(first), Some(second), Some(third), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    has_ascii_lowercase_len(first, 3)
        && has_ascii_lowercase_len(second, 4)
        && has_ascii_lowercase_len(third, 3)
}

fn has_ascii_lowercase_len(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| matches!(byte, b'a'..=b'z'))
}

fn is_zoom_meeting_url(host: &str, path: &str) -> bool {
    is_zoom_host(host)
        && (path.strip_prefix("/j/").is_some_and(is_zoom_meeting_id)
            || path
                .strip_prefix("/wc/join/")
                .is_some_and(is_zoom_meeting_id)
            || is_zoom_web_client_meeting_url(path)
            || path
                .strip_prefix("/my/")
                .is_some_and(has_single_non_empty_segment))
}

fn is_zoom_meeting_id(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    (9..=11).contains(&value.len()) && value.bytes().all(|byte| matches!(byte, b'0'..=b'9'))
}

fn is_zoom_web_client_meeting_url(path: &str) -> bool {
    let Some(value) = path.strip_prefix("/wc/") else {
        return false;
    };
    let value = value.strip_suffix('/').unwrap_or(value);
    let Some((meeting_id, action)) = value.split_once('/') else {
        return false;
    };
    action == "join" && is_zoom_meeting_id(meeting_id)
}

fn is_teams_meeting_url(host: &str, path: &str, query: Option<&str>) -> bool {
    (is_teams_work_or_school_host(host)
        && path
            .strip_prefix("/l/meetup-join/")
            .is_some_and(has_non_empty_path_segments))
        || (is_teams_work_or_school_host(host)
            && (path == "/v2" || path == "/v2/")
            && query_has_param(query, "meetingjoin", "true"))
        || (is_teams_work_or_school_host(host)
            && path
                .strip_prefix("/meet/")
                .is_some_and(has_single_non_empty_segment))
        || (host == "teams.live.com"
            && path
                .strip_prefix("/meet/")
                .is_some_and(has_single_non_empty_segment))
}

fn is_teams_work_or_school_host(host: &str) -> bool {
    host == "teams.microsoft.com" || host == "teams.cloud.microsoft"
}

fn has_non_empty_path_segments(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    !value.is_empty() && value.split('/').all(|segment| !segment.is_empty())
}

fn has_single_non_empty_segment(value: &str) -> bool {
    let value = value.strip_suffix('/').unwrap_or(value);
    !value.is_empty() && !value.contains('/')
}

fn query_has_param(query: Option<&str>, key: &str, value: &str) -> bool {
    query.is_some_and(|query| {
        query.split('&').any(|param| {
            let (param_key, param_value) = param.split_once('=').unwrap_or((param, ""));
            param_key.eq_ignore_ascii_case(key) && param_value.eq_ignore_ascii_case(value)
        })
    })
}

// ─────────────────────────────────────────────
// macOS 固有の実装 (Swift bridge 呼び出し)
// ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void, CStr, CString};

    use super::{handle_browser_url_detection, handle_detection, WATCHED_BUNDLE_IDS};

    type DetectionCallback =
        extern "C" fn(bundle_id: *const c_char, app_name: *const c_char, user_data: *mut c_void);

    extern "C" {
        fn meet_jerky_app_detection_start(
            bundle_ids_json: *const c_char,
            callback: DetectionCallback,
            browser_url_callback: BrowserUrlCallback,
            user_data: *mut c_void,
        ) -> i32;

        #[allow(dead_code)]
        fn meet_jerky_app_detection_stop();
    }

    type BrowserUrlCallback = extern "C" fn(
        bundle_id: *const c_char,
        browser_name: *const c_char,
        url: *const c_char,
        window_title: *const c_char,
        user_data: *mut c_void,
    );

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

    extern "C" fn browser_url_callback(
        bundle_id: *const c_char,
        browser_name: *const c_char,
        url: *const c_char,
        window_title: *const c_char,
        _user_data: *mut c_void,
    ) {
        if bundle_id.is_null() || browser_name.is_null() || url.is_null() {
            return;
        }

        // Safety: Swift 側でコールバック呼び出しの間だけ valid な C 文字列。
        // ここで String にコピーし、URL 全文は分類にのみ使う。
        let bundle = unsafe { CStr::from_ptr(bundle_id) }
            .to_string_lossy()
            .into_owned();
        let name = unsafe { CStr::from_ptr(browser_name) }
            .to_string_lossy()
            .into_owned();
        let active_url = unsafe { CStr::from_ptr(url) }
            .to_string_lossy()
            .into_owned();
        let title = if window_title.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(window_title) }
                .to_string_lossy()
                .into_owned()
        };

        std::thread::spawn(move || {
            handle_browser_url_detection(&bundle, &name, &active_url, &title);
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
                browser_url_callback,
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
    fn watched_bundle_ids_includes_native_meeting_apps() {
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
        assert!(
            ids.contains(&"com.apple.FaceTime"),
            "FaceTime Bundle ID が抜けています"
        );
    }

    #[test]
    fn meeting_app_detected_payload_serializes_camel_case() {
        // フロントエンドの型定義 (camelCase) と整合する形でシリアライズされること
        let payload = MeetingAppDetectedPayload::App {
            bundle_id: "us.zoom.xos".to_string(),
            app_name: "Zoom".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"bundleId\":\"us.zoom.xos\""));
        assert!(json.contains("\"appName\":\"Zoom\""));
        assert!(json.contains("\"source\":\"app\""));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("url"));
        assert!(!object.contains_key("fullUrl"));
        assert!(!object.contains_key("urlHost"));
        assert!(!object.contains_key("browserName"));
        assert!(!object.contains_key("windowTitle"));
        assert!(!object.contains_key("service"));
        assert!(!json.contains("bundle_id"));
    }

    #[test]
    fn browser_meeting_payload_serializes_without_full_url() {
        let payload = MeetingAppDetectedPayload::Browser {
            bundle_id: "com.apple.Safari".to_string(),
            app_name: "Safari".to_string(),
            service: "Google Meet".to_string(),
            url_host: "meet.google.com".to_string(),
            browser_name: "Safari".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"bundleId\":\"com.apple.Safari\""));
        assert!(json.contains("\"appName\":\"Safari\""));
        assert!(json.contains("\"source\":\"browser\""));
        assert!(json.contains("\"service\":\"Google Meet\""));
        assert!(json.contains("\"urlHost\":\"meet.google.com\""));
        assert!(json.contains("\"browserName\":\"Safari\""));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("url"));
        assert!(!object.contains_key("fullUrl"));
        assert!(!object.contains_key("windowTitle"));
        assert!(!json.contains("abc-defg-hij"));
        assert!(!json.contains("authuser=0"));
        assert!(!json.contains("windowTitle"));
    }

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
            classify_meeting_url("https://meet.google.com:443/abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com./abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url(" HTTPS://MEET.GOOGLE.COM/abc-defg-hij?authuser=0#meeting "),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defg-hij/"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/abcdefg"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/abcdefg/"),
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
            classify_meeting_url("https://company.zoom.us/j/123456789/"),
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
            classify_meeting_url("https://zoom.us/wc/join/123456789/"),
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
            classify_meeting_url("https://zoom.us/wc/123456789/join"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://company.zoom.us/wc/12345678901/join/"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "company.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://us02web.zoom.us/j/12345678901#success"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "us02web.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://us02web.zoom.us/my/team.sync?pwd=secret"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "us02web.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://company-name.zoom.us/j/123456789"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "company-name.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://zoom.us/my/personal-room/"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://company.zoom.us./j/123456789"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "company.zoom.us".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://zoomgov.com/j/1600991835?pwd=secret"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "zoomgov.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://agency.zoomgov.com/wc/join/1600991835"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "agency.zoomgov.com".to_string(),
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
            classify_meeting_url("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=secret#meeting"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0/"),
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
        assert_eq!(
            classify_meeting_url("https://teams.live.com/meet/1234567890123/"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.live.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/?meetingjoin=true&context=secret"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2?MEETINGJOIN=TRUE#meeting"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com./v2?meetingjoin=true"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet/1234567890123?p=passcode"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet/1234567890123/"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url(
                "https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_abc/0?context=secret"
            ),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.cloud.microsoft".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.cloud.microsoft/v2?meetingjoin=true"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.cloud.microsoft".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://teams.cloud.microsoft/meet/1234567890123?p=passcode"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.cloud.microsoft".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_rejects_non_meeting_or_non_join_urls() {
        assert_eq!(classify_meeting_url("https://zoom.us/profile"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/j/"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/j/12345678"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/j/abc"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/j/123/extra"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/j/123456789//"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/j/123456789012"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/wc/profile"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/wc/join/"), None);
        assert_eq!(classify_meeting_url("https://zoom.us/wc/join/abc"), None);
        assert_eq!(
            classify_meeting_url("https://zoom.us/wc/join/123456789//"),
            None
        );
        assert_eq!(classify_meeting_url("https://zoom.us/wc/123456789"), None);
        assert_eq!(
            classify_meeting_url("https://zoom.us/wc/123456789/start"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://zoom.us/wc/123456789/join/extra"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://zoom.us/wc/12345678/join"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://zoom.us/wc/123456789012/join"),
            None
        );
        assert_eq!(classify_meeting_url("https://zoom.us/my/"), None);
        assert_eq!(
            classify_meeting_url("https://zoom.us/my/personal/extra"),
            None
        );
        assert_eq!(classify_meeting_url("https://.zoom.us/j/123456789"), None);
        assert_eq!(
            classify_meeting_url("https://evil..zoom.us/j/123456789"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://bad_label.zoom.us/j/123456789"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://-bad.zoom.us/j/123456789"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://bad-.zoom.us/j/123456789"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://evil..zoomgov.com/j/1600991835"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://evilzoomgov.com/j/1600991835"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com../abc-defg-hij"),
            None
        );
        assert_eq!(classify_meeting_url("https://evilzoom.us/j/123"), None);
        assert_eq!(classify_meeting_url("https://example.com/j/123"), None);
        assert_eq!(classify_meeting_url("https://meet.google.com/"), None);
        assert_eq!(
            classify_meeting_url("https://meet.google.com/landing"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defg"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/ABC-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defg-hij/extra"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defg-hij//"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup//"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/a/b"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/a//"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://calendar.google.com/lookup/abcdefg"),
            None
        );
        assert_eq!(classify_meeting_url("https://teams.microsoft.com/"), None);
        assert_eq!(classify_meeting_url("https://teams.microsoft.com/_"), None);
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/l/meetup-join/"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/l/meetup-join//"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/l/meetup-join/secret//extra"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/?meetingjoin=false"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/extra?meetingjoin=true"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2#fragment?meetingjoin=true"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet/"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet//"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet/123/extra"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet/123//"),
            None
        );
        assert_eq!(classify_meeting_url("https://teams.cloud.microsoft/"), None);
        assert_eq!(
            classify_meeting_url("https://teams.cloud.microsoft/l/meetup-join/"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.cloud.microsoft/v2?meetingjoin=false"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.cloud.microsoft/meet/123/extra"),
            None
        );
        assert_eq!(classify_meeting_url("https://teams.live.com/free"), None);
        assert_eq!(classify_meeting_url("https://teams.live.com/meet/"), None);
        assert_eq!(classify_meeting_url("https://teams.live.com/meet//"), None);
        assert_eq!(
            classify_meeting_url("https://teams.live.com/meet/1234567890123/extra"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.live.com/meet/1234567890123//"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_non_http_urls() {
        assert_eq!(classify_meeting_url("meet.google.com/abc-defg-hij"), None);
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/a b"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com/lookup/a\u{3000}b"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://zoom.us/j/123456789 ?pwd=x"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/meet/1234567890123\t?p=x"),
            None
        );
        assert_eq!(
            classify_meeting_url(" https://meet.google.com/lookup/a%20b "),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("file://meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("mailto:https://meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:notaport/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:65536/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://[meet.google.com]/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://[meet.google.com]:443/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://user@meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://evil.example@meet.google.com/abc-defg-hij"),
            None
        );
    }
}
