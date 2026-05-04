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
//!    - macOS 通知センターに通知を出す
//!    - フロントエンドへ `meeting-app-detected` イベントを emit
//! 5. フロントエンドがバナー描画後に専用 prompt window を表示し、ユーザーがアプリ側で録音と文字起こしの状態を確認する

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// 会議アプリが「inactive (終了した可能性が高い)」と判定する閾値。
/// `should_notify_meeting_inactive` の `inactive_threshold_secs` 引数に渡す。
/// 600 秒 = 10 分。これより短いと画面共有等で URL polling が止まる正常状態を誤検知する恐れ。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MEETING_INACTIVE_THRESHOLD: Duration = Duration::from_secs(600);

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
    latest_payload: Mutex<Option<MeetingAppDetectedPayload>>,
    /// `should_notify_meeting_inactive` 用の epoch secs ベースの最終検知時刻 (案 A 二重管理)。
    last_seen_secs: Mutex<HashMap<String, u64>>,
    /// `should_notify_meeting_inactive` 用の最終 inactive 通知時刻 (epoch secs)。
    /// wrapper 関数 `check_meeting_inactive_for_bundle` がスロットリング判定に使う。
    last_notified_secs: Mutex<HashMap<String, u64>>,
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
            latest_payload: Mutex::new(None),
            last_seen_secs: Mutex::new(HashMap::new()),
            last_notified_secs: Mutex::new(HashMap::new()),
        })
        .is_ok();

    if first_time {
        #[cfg(target_os = "macos")]
        {
            macos::start_detection();

            // 会議終了検知タイマー: 60 秒周期で全 watched bundle を check し、
            // 必要なら inactive 通知を発火する。
            std::thread::spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                check_all_inactive_bundles();
            });
        }
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

    // `should_notify_meeting_inactive` 用に epoch secs ベースの最終検知時刻を更新する
    // (案 A 二重管理: 既存 Instant ベース throttle と並走、Loop 3 で wrapper 関数が読み取る予定)。
    {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        state
            .last_seen_secs
            .lock()
            .insert(bundle_id.to_string(), now_secs);
    }

    // 通知センターに通知を出す
    show_notification(&state.app_handle, app_name);

    // フロントエンド (バナー表示・録音/文字起こし状態確認導線) へイベントを通知
    let payload = MeetingAppDetectedPayload::App {
        bundle_id: bundle_id.to_string(),
        app_name: app_name.to_string(),
    };
    *state.latest_payload.lock() = Some(payload.clone());
    match state.app_handle.emit("meeting-app-detected", &payload) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("[app_detection] emit failed: {e}");
        }
    }
}

/// browser_url_callback の発火間隔が想定より大幅に遅延しているかを判定する純粋関数。
/// `Some(elapsed)` は警告対象の経過秒数、`None` は警告不要。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn should_warn_polling_stall(
    now_secs: u64,
    last_seen_secs: u64,
    last_warned_secs: u64,
    expected_interval_secs: u64,
    throttle_secs: u64,
) -> Option<u64> {
    if last_seen_secs == 0 {
        return None;
    }
    if now_secs <= last_seen_secs {
        return None;
    }
    let elapsed = now_secs - last_seen_secs;
    if elapsed <= expected_interval_secs * 3 {
        return None;
    }
    if now_secs.saturating_sub(last_warned_secs) < throttle_secs {
        return None;
    }
    Some(elapsed)
}

/// 監視中の会議アプリが長時間検知されない場合に「会議終了」通知を発火すべきかを判定する純粋関数。
/// `Some(elapsed)` は通知対象の経過秒数、`None` は通知不要。
#[allow(dead_code)]
fn should_notify_meeting_inactive(
    now_secs: u64,
    last_seen_secs: u64,
    last_notified_secs: u64,
    inactive_threshold_secs: u64,
    throttle_secs: u64,
) -> Option<u64> {
    if last_seen_secs == 0 {
        return None;
    }
    if now_secs <= last_seen_secs {
        return None;
    }
    let elapsed = now_secs - last_seen_secs;
    if elapsed < inactive_threshold_secs {
        return None;
    }
    if now_secs.saturating_sub(last_notified_secs) < throttle_secs {
        return None;
    }
    Some(elapsed)
}

/// `last_seen_secs` HashMap の key (throttle_key) が会議 inactive 通知の発火対象かを判定する wrapper。
///
/// throttle_key は bundle_id 単独 / `"browser:..."` / `"window-title:..."` の 3 形式が混在する。
/// `DetectionState` から `last_seen_secs` / `last_notified_secs` を読み、
/// 純粋関数 `should_notify_meeting_inactive` を呼ぶ。`Some(elapsed)` を返した
/// ときは副作用として `last_notified_secs` も書き込む (スロットリング更新)。
///
/// `STATE` 未初期化または対象 throttle_key が一度も検知されていない場合は `None`。
/// std::thread タイマーから定期的に呼ばれる。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn check_meeting_inactive_for_bundle(throttle_key: &str) -> Option<u64> {
    let state = STATE.get()?;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last_seen_secs = state
        .last_seen_secs
        .lock()
        .get(throttle_key)
        .copied()
        .unwrap_or(0);
    let last_notified_secs = state
        .last_notified_secs
        .lock()
        .get(throttle_key)
        .copied()
        .unwrap_or(0);
    let result = should_notify_meeting_inactive(
        now_secs,
        last_seen_secs,
        last_notified_secs,
        MEETING_INACTIVE_THRESHOLD.as_secs(),
        NOTIFICATION_THROTTLE.as_secs(),
    );
    if result.is_some() {
        state
            .last_notified_secs
            .lock()
            .insert(throttle_key.to_string(), now_secs);
    }
    result
}

/// `last_seen_secs` の key 全件を巡回し、`parse_throttle_key_to_display_name` で
/// display name に変換した上で `check_meeting_inactive_for_bundle` を呼ぶ。
/// アプリ経路 (Zoom/Teams/FaceTime) と browser 経路 (Safari 等) の両方が対象。
/// `Some(elapsed)` が返ったら `show_inactive_notification` を発火する。
/// タイマースレッドから定期的に呼ばれる。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn check_all_inactive_bundles() {
    let state = match STATE.get() {
        Some(s) => s,
        None => return,
    };
    // last_seen_secs MutexGuard を即解放してから iterate (デッドロック回避)。
    // throttle_key は 3 形式の混在 (bundle_id 単独 / "browser:..." / "window-title:...") =
    // parse_throttle_key_to_display_name で表示名に解釈する。
    let throttle_keys: Vec<String> = state.last_seen_secs.lock().keys().cloned().collect();
    for throttle_key in throttle_keys {
        if let Some(app_name) = parse_throttle_key_to_display_name(&throttle_key) {
            if let Some(elapsed) = check_meeting_inactive_for_bundle(&throttle_key) {
                show_inactive_notification(&state.app_handle, &app_name, elapsed);
            }
        }
    }
}

/// Swift 側からブラウザのアクティブタブ URL が上がってきたときのハンドラ。
///
/// URL 全文はここで分類にのみ使い、payload / 通知 / log には出さない。
/// URL 取得失敗時 (空文字・`about:blank`・AppleScript 権限不足等) は
/// `window_title` から会議サービスを推定するフォールバックを試みる。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn handle_browser_url_detection(
    bundle_id: &str,
    browser_name: &str,
    url: &str,
    window_title: &str,
) {
    static LAST_BROWSER_CALLBACK_SEEN_SECS: AtomicU64 = AtomicU64::new(0);
    static LAST_BROWSER_CALLBACK_WARN_SECS: AtomicU64 = AtomicU64::new(0);

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Some(elapsed_secs) = should_warn_polling_stall(
        now_secs,
        LAST_BROWSER_CALLBACK_SEEN_SECS.load(Ordering::Relaxed),
        LAST_BROWSER_CALLBACK_WARN_SECS.load(Ordering::Relaxed),
        3,
        NOTIFICATION_THROTTLE.as_secs(),
    ) {
        eprintln!(
            "[app_detection] browser_url_callback の前回発火から {elapsed_secs}s 経過 (期待 ~3s)。Swift Timer または AppleScript が停滞している可能性。"
        );
        LAST_BROWSER_CALLBACK_WARN_SECS.store(now_secs, Ordering::Relaxed);
    }
    LAST_BROWSER_CALLBACK_SEEN_SECS.store(now_secs, Ordering::Relaxed);

    // url と window_title の両方が空 → AppleScript 権限不足や取得失敗の疑い。
    // 60 秒スロットリング付きで診断ログを出す (静かに silent fail させない)。
    if url.is_empty() && window_title.is_empty() {
        static LAST_EMPTY_BROWSER_LOG_SECS: AtomicU64 = AtomicU64::new(0);
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let last = LAST_EMPTY_BROWSER_LOG_SECS.load(Ordering::Relaxed);
        if now_secs.saturating_sub(last) >= NOTIFICATION_THROTTLE.as_secs() {
            LAST_EMPTY_BROWSER_LOG_SECS.store(now_secs, Ordering::Relaxed);
            eprintln!(
                "[app_detection] {browser_name} (bundle: {bundle_id}) で URL/タイトル両方取得失敗。AppleScript 権限を確認してください。"
            );
        }
        return;
    }

    // URL ベースの分類を優先し、失敗した場合のみウィンドウタイトルをフォールバックとして試みる。
    // throttle_key はソース (browser / window-title) を区別するためプレフィックスを変える。
    // これにより URL 由来と window title 由来の検知が互いのスロットリングに干渉しない。
    let (classification, throttle_key) = if let Some(c) = classify_meeting_url(url) {
        let key = format!("browser:{bundle_id}:{}:{}", c.service, c.host);
        (c, key)
    } else if let Some(c) = classify_meeting_window_title(window_title) {
        // window title 由来: host は空文字。URL ベースと throttle_key を区別する。
        let key = format!("window-title:{bundle_id}:{}", c.service);
        (c, key)
    } else {
        return;
    };

    let state = match STATE.get() {
        Some(s) => s,
        None => return,
    };

    {
        let mut last_seen = state.last_seen.lock();
        let now = Instant::now();
        if let Some(prev) = last_seen.get(&throttle_key) {
            if now.duration_since(*prev) < NOTIFICATION_THROTTLE {
                return;
            }
        }
        last_seen.insert(throttle_key.clone(), now);
    }

    // `should_notify_meeting_inactive` 用に epoch secs ベースの最終検知時刻を更新する
    // (案 A 二重管理: 既存 Instant ベース throttle と並走)。
    {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        state.last_seen_secs.lock().insert(throttle_key, now_secs);
    }

    show_notification(&state.app_handle, &classification.service);

    let payload = MeetingAppDetectedPayload::Browser {
        bundle_id: bundle_id.to_string(),
        app_name: browser_name.to_string(),
        service: classification.service,
        url_host: classification.host, // window title 由来の場合は空文字 ""
        browser_name: browser_name.to_string(),
    };
    *state.latest_payload.lock() = Some(payload.clone());
    match state.app_handle.emit("meeting-app-detected", &payload) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("[app_detection] browser emit failed: {e}");
        }
    }
}

#[tauri::command]
pub fn take_latest_meeting_detection() -> Option<MeetingAppDetectedPayload> {
    STATE
        .get()
        .and_then(|state| state.latest_payload.lock().take())
}

fn show_notification(app: &AppHandle, app_name: &str) {
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
fn show_inactive_notification(app: &AppHandle, app_name: &str, elapsed_secs: u64) {
    use tauri_plugin_notification::NotificationExt;

    let title = "Meet Jerky";
    let body = inactive_notification_body(app_name, elapsed_secs);

    if let Err(e) = app.notification().builder().title(title).body(&body).show() {
        eprintln!("[app_detection] inactive notification show failed: {e}");
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn notification_body(app_name: &str) -> String {
    format!(
        "{app_name} を検出しました。自分/相手側トラックの録音と文字起こしの状態をアプリで確認してください。"
    )
}

/// inactive 通知の本文を生成する純粋関数。
/// app_name と elapsed_secs を受け取って表示文を整形する。test 容易性のため `show_inactive_notification` から分離。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn inactive_notification_body(app_name: &str, elapsed_secs: u64) -> String {
    let elapsed_min = elapsed_secs / 60;
    format!(
        "{app_name} が {elapsed_min} 分以上検知されていません。会議が終了している場合は録音と文字起こしを停止してください。"
    )
}

/// throttle_key を会議アプリ表示名に変換する純粋関数。
///
/// `last_seen_secs` HashMap に格納される 3 つの key 形式を解釈する:
/// - **アプリ経路 (handle_detection)**: bundle_id 単独 (例: `"us.zoom.xos"`) → `WATCHED_BUNDLE_IDS` lookup で `Some("Zoom")`
/// - **browser 経路**: `"browser:<bundle_id>:<service>:<host>"` → 3 つ目のセグメント (service) を `Some` で返す
/// - **window-title 経路**: `"window-title:<bundle_id>:<service>"` → 3 つ目のセグメント (service) を `Some` で返す
/// - 上記いずれにも該当しない不正形式・未知 bundle_id は `None` を返す
///
/// `check_all_inactive_bundles` の iteration で `last_seen_secs` の key 全件巡回時に
/// display name を解決するために呼ばれる。
fn parse_throttle_key_to_display_name(key: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix("browser:") {
        // "browser:<bundle_id>:<service>:<host>" → splitn(3, ':') → [bundle_id, service, host]
        let parts: Vec<&str> = rest.splitn(3, ':').collect();
        if parts.len() < 2 {
            return None;
        }
        let service = parts[1];
        if service.is_empty() {
            return None;
        }
        return Some(service.to_string());
    }
    if let Some(rest) = key.strip_prefix("window-title:") {
        // "window-title:<bundle_id>:<service>" → splitn(2, ':') → [bundle_id, service]
        let parts: Vec<&str> = rest.splitn(2, ':').collect();
        if parts.len() < 2 {
            return None;
        }
        let service = parts[1];
        if service.is_empty() {
            return None;
        }
        return Some(service.to_string());
    }
    // アプリ経路: bundle_id 単独 → WATCHED_BUNDLE_IDS lookup
    WATCHED_BUNDLE_IDS
        .iter()
        .find(|(bundle_id, _)| *bundle_id == key)
        .map(|(_, app_name)| app_name.to_string())
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
    } else if is_webex_meeting_url(&host, &parsed.path)
        || is_webex_jphp_meeting_url(&host, &parsed.path, parsed.query.as_deref())
        || is_webex_wbxmjs_meeting_url(&host, &parsed.path)
        || is_webex_webappng_meeting_url(&host, &parsed.path)
    {
        "Webex"
    } else if is_whereby_meeting_url(&host, &parsed.path) {
        "Whereby"
    } else if is_goto_meeting_url(&host, &parsed.path)
        || is_goto_legacy_meeting_url(&host, &parsed.path)
    {
        "GoToMeeting"
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

/// ブラウザのウィンドウタイトルから会議サービスを分類する純粋関数。
///
/// `classify_meeting_url` が `None` を返した場合 (URL 空・`about:blank`・AppleScript
/// 権限不足等) のフォールバックとして `handle_browser_url_detection` 内で使う。
///
/// 戻り値は [`MeetingUrlClassification`] を再利用するが、`host` フィールドは URL ホスト名
/// ではなく **空文字 `""`** を返す。window title 由来であることは呼び出し側の throttle_key
/// (`"window-title:{bundle_id}:{service}"` 形式) で区別する。
///
/// # 分類ルール (厳格・誤検知防止を優先)
///
/// - **Google Meet**: `"Meet - "` / `"Meet – "` (U+2013) / `"Meet — "` (U+2014) で始まり、
///   続く会議コードまたは名前が非空のもの。Chrome/Safari/Edge のタブタイトルを想定。
/// - **Zoom**: `"Zoom Meeting"` または `"Zoom ミーティング"` で始まるもの (prefix 一致)。
///   デスクトップアプリのウィンドウタイトルを想定。`starts_with` のみ使い
///   `"Zoom について - Wikipedia"` のような単語含みによる誤検知を防ぐ。
/// - **Webex**: `"Webex Meeting"` で始まるもの (prefix 一致、Zoom と同型)。
///   ブラウザタブタイトルを想定。実機で形式未確認のため、検知漏れ時は実環境観察後に拡張。
/// - **Microsoft Teams**: ブラウザ版のタイトルパターン (`"Microsoft Teams"` suffix 等) は
///   外部チュートリアルや解説ページと区別できないため今回は fallback 対象外とする。
///   Teams はデスクトップアプリ (Bundle ID: `com.microsoft.teams2`) 経由で検知される。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn classify_meeting_window_title(window_title: &str) -> Option<MeetingUrlClassification> {
    // Google Meet のタブタイトルは Chrome/Safari/Edge とも "Meet - <code or name>" 形式。
    // ASCII ハイフン・en-dash (U+2013)・em-dash (U+2014) の3種をカバーし、
    // 続く名前が空 ("Meet - " のみ) の場合は会議ではないとして除外する。
    let google_meet_detected =
        ["Meet - ", "Meet \u{2013} ", "Meet \u{2014} "]
            .iter()
            .any(|prefix| {
                window_title
                    .strip_prefix(prefix)
                    .is_some_and(|rest| !rest.is_empty())
            });
    if google_meet_detected {
        return Some(MeetingUrlClassification {
            service: "Google Meet".to_string(),
            host: String::new(),
        });
    }

    // Zoom デスクトップアプリのウィンドウタイトルは "Zoom Meeting" / "Zoom ミーティング"
    // で始まる。続く文字列 (参加者名等) があってもよい (prefix 一致)。
    if window_title.starts_with("Zoom Meeting") || window_title.starts_with("Zoom ミーティング")
    {
        return Some(MeetingUrlClassification {
            service: "Zoom".to_string(),
            host: String::new(),
        });
    }

    // Webex のブラウザタブタイトルは "Webex Meeting | <site>" または "Webex Meeting" 始まり
    // と仮定 (実機未確認、Zoom と同じ保守性レベル)。日本語タイトル ("Webex ミーティング" 等) は
    // 仕様未確認のため将来課題。
    if window_title.starts_with("Webex Meeting") {
        return Some(MeetingUrlClassification {
            service: "Webex".to_string(),
            host: String::new(),
        });
    }

    None
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
        .find(['/', '?', '#'])
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
            let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
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
    value.len() == len && value.bytes().all(|byte: u8| byte.is_ascii_lowercase())
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
    (9..=11).contains(&value.len()) && value.bytes().all(|byte: u8| byte.is_ascii_digit())
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

fn is_webex_host(host: &str) -> bool {
    if host == "webex.com" {
        return true;
    }
    let Some(subdomain) = host.strip_suffix(".webex.com") else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

fn is_webex_meeting_url(host: &str, path: &str) -> bool {
    // Personal Room (`/meet/<id>`) / j.php 招待 URL (`/<site>/j.php?MTID=<token>`) /
    // wbxmjs Meeting Join Service URL (`/wbxmjs/joinservice/sites/<site>/meeting/...`) /
    // webappng URL (`/webappng/sites/<site>/meeting/info/<token>`) に対応。
    // 他の Webex URL 形式は誤検知防止のため将来課題。
    is_webex_host(host)
        && path
            .strip_prefix("/meet/")
            .is_some_and(has_single_non_empty_segment)
}

fn is_jphp_path(path: &str) -> bool {
    let path = path.strip_suffix('/').unwrap_or(path);
    let Some(inner) = path.strip_prefix('/') else {
        return false;
    };
    let Some((segment, tail)) = inner.split_once('/') else {
        return false;
    };
    !segment.is_empty() && tail == "j.php"
}

fn is_webex_jphp_meeting_url(host: &str, path: &str, query: Option<&str>) -> bool {
    is_webex_host(host) && is_jphp_path(path) && query_has_non_empty_param(query, "MTID")
}

fn is_wbxmjs_path(path: &str) -> bool {
    let path = path.strip_suffix('/').unwrap_or(path);
    let Some(rest) = path.strip_prefix("/wbxmjs/joinservice/sites/") else {
        return false;
    };
    let Some((site, after_site)) = rest.split_once('/') else {
        return false;
    };
    if site.is_empty() {
        return false;
    }
    let meeting_segment = after_site
        .split_once('/')
        .map_or(after_site, |(head, _)| head);
    meeting_segment == "meeting"
}

fn is_webex_wbxmjs_meeting_url(host: &str, path: &str) -> bool {
    is_webex_host(host) && is_wbxmjs_path(path)
}

fn is_webappng_path(path: &str) -> bool {
    let path = path.strip_suffix('/').unwrap_or(path);
    let Some(rest) = path.strip_prefix("/webappng/sites/") else {
        return false;
    };
    let Some((site, after_site)) = rest.split_once('/') else {
        return false;
    };
    if site.is_empty() {
        return false;
    }
    let Some(after_meeting) = after_site.strip_prefix("meeting/") else {
        return false;
    };
    let Some((action, token)) = after_meeting.split_once('/') else {
        return false;
    };
    action == "info" && !token.is_empty()
}

fn is_webex_webappng_meeting_url(host: &str, path: &str) -> bool {
    is_webex_host(host) && is_webappng_path(path)
}

const WHEREBY_NON_ROOM_PATHS: &[&str] = &[
    "about",
    "pricing",
    "blog",
    "login",
    "signup",
    "help",
    "terms",
    "privacy",
    "contact",
    "features",
    "customers",
    "embedded",
    "embed",
    "information",
    "api",
    "products",
    "integrations",
    "security",
    "careers",
    "status",
    "download",
    "app",
    "for-teams",
    "developers",
];

const GOTO_NON_ROOM_PATHS: &[&str] = &[
    "about", "pricing", "blog", "login", "signup", "help", "terms", "privacy", "contact",
    "products", "features", "download", "app", "api", "security", "status",
];

fn is_whereby_host(host: &str) -> bool {
    if host == "whereby.com" {
        return true;
    }
    let Some(subdomain) = host.strip_suffix(".whereby.com") else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

fn is_whereby_meeting_url(host: &str, path: &str) -> bool {
    if !is_whereby_host(host) {
        return false;
    }
    let Some(room) = path.strip_prefix('/') else {
        return false;
    };
    let room = room.strip_suffix('/').unwrap_or(room);
    !room.is_empty() && !room.contains('/') && !WHEREBY_NON_ROOM_PATHS.contains(&room)
}

fn is_goto_host(host: &str) -> bool {
    if host == "meet.goto.com" {
        return true;
    }
    let Some(subdomain) = host.strip_suffix(".meet.goto.com") else {
        return false;
    };
    !subdomain.is_empty() && subdomain.split('.').all(is_valid_dns_label)
}

fn is_goto_meeting_url(host: &str, path: &str) -> bool {
    if !is_goto_host(host) {
        return false;
    }
    let Some(room) = path.strip_prefix('/') else {
        return false;
    };
    let room = room.strip_suffix('/').unwrap_or(room);
    !room.is_empty() && !room.contains('/') && !GOTO_NON_ROOM_PATHS.contains(&room)
}

fn is_goto_legacy_meeting_url(host: &str, path: &str) -> bool {
    if host != "global.gotomeeting.com" {
        return false;
    }
    let Some(id) = path.strip_prefix("/join/") else {
        return false;
    };
    let id = id.strip_suffix('/').unwrap_or(id);
    id.len() == 9 && id.chars().all(|c| c.is_ascii_digit())
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

fn query_has_non_empty_param(query: Option<&str>, key: &str) -> bool {
    query.is_some_and(|query| {
        query.split('&').any(|param| {
            let (param_key, param_value) = param.split_once('=').unwrap_or((param, ""));
            param_key.eq_ignore_ascii_case(key) && !param_value.is_empty()
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

    // ─────────────────────────────────────────────
    // classify_meeting_window_title のテスト
    // ─────────────────────────────────────────────

    #[test]
    fn classify_meeting_window_title_google_meet_hyphen() {
        assert_eq!(
            classify_meeting_window_title("Meet - abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_google_meet_dash_variants() {
        // en-dash (U+2013)
        assert_eq!(
            classify_meeting_window_title("Meet \u{2013} チームミーティング"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: String::new(),
            })
        );
        // em-dash (U+2014)
        assert_eq!(
            classify_meeting_window_title("Meet \u{2014} Team Sync"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_zoom_meeting_english() {
        assert_eq!(
            classify_meeting_window_title("Zoom Meeting"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_zoom_meeting_english_with_suffix() {
        assert_eq!(
            classify_meeting_window_title("Zoom Meeting (山田太郎)"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_zoom_meeting_japanese() {
        assert_eq!(
            classify_meeting_window_title("Zoom ミーティング"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_zoom_meeting_japanese_with_suffix() {
        assert_eq!(
            classify_meeting_window_title("Zoom ミーティング (田中一郎)"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_rejects_empty_string() {
        assert_eq!(classify_meeting_window_title(""), None);
    }

    #[test]
    fn classify_meeting_window_title_rejects_zoom_wikipedia() {
        // "Zoom" という単語を含むだけのページは誤検知しない
        assert_eq!(
            classify_meeting_window_title("Zoom について - Wikipedia"),
            None
        );
        assert_eq!(
            classify_meeting_window_title("How to use Zoom Meeting feature"),
            None
        );
    }

    #[test]
    fn classify_meeting_window_title_rejects_meet_alone() {
        // "Meet" 単独・空のコードは会議タブではない
        assert_eq!(classify_meeting_window_title("Meet"), None);
        assert_eq!(classify_meeting_window_title("Google Meet"), None);
    }

    #[test]
    fn classify_meeting_window_title_rejects_meet_prefix_only() {
        // "Meet - " の後ろが空 (= 会議コード未セット) は除外する
        assert_eq!(classify_meeting_window_title("Meet - "), None);
        assert_eq!(classify_meeting_window_title("Meet \u{2013} "), None);
    }

    #[test]
    fn classify_meeting_window_title_rejects_teams_excluded() {
        // Microsoft Teams のブラウザ版タイトルは誤検知リスクから今回は fallback 対象外
        assert_eq!(classify_meeting_window_title("Microsoft Teams"), None);
        assert_eq!(
            classify_meeting_window_title("週次定例 | Microsoft Teams"),
            None
        );
    }

    #[test]
    fn classify_meeting_window_title_rejects_unrelated_title() {
        assert_eq!(
            classify_meeting_window_title("Google カレンダー - 2026年5月"),
            None
        );
        assert_eq!(classify_meeting_window_title("about:blank"), None);
        assert_eq!(classify_meeting_window_title("新しいタブ"), None);
    }

    #[test]
    fn should_warn_polling_stall_first_call_returns_none() {
        // last_seen_secs == 0 は初回起動: 警告しない
        assert_eq!(should_warn_polling_stall(1000, 0, 0, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_within_normal_range_returns_none() {
        // elapsed = 5s <= expected(3) * 3 = 9s: 正常範囲なので警告しない
        assert_eq!(should_warn_polling_stall(1000, 995, 0, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_stalled_returns_some_elapsed() {
        // elapsed = 30s > 9s, 未警告 → Some(30)
        assert_eq!(should_warn_polling_stall(1000, 970, 0, 3, 60), Some(30));
    }

    #[test]
    fn should_warn_polling_stall_throttled_returns_none() {
        // elapsed = 30s > 9s だが 30s 前に警告済み (throttle=60s) → None
        assert_eq!(should_warn_polling_stall(1000, 970, 970, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_boundary_at_expected_times_three_returns_none() {
        // 境界: elapsed == expected_interval_secs * 3 ぴったり (= 9s) は正常範囲扱いで None
        // (実装は `elapsed <= expected_interval_secs * 3` で短絡)。
        // この境界を保護する: `<=` を `<` に変える誤改修を CI で検知。
        assert_eq!(should_warn_polling_stall(1009, 1000, 0, 3, 60), None);
        // 境界の 1 秒外: elapsed = 10 > 9 で Some(10)
        assert_eq!(should_warn_polling_stall(1010, 1000, 0, 3, 60), Some(10));
    }

    #[test]
    fn should_warn_polling_stall_clock_skew_last_warned_after_now_returns_none() {
        // clock 巻き戻し相当: last_warned_secs > now_secs。
        // saturating_sub で 0 に飽和し、0 < throttle (60) で None を返す契約を固定。
        // saturating_sub を sub に変える panic 化、または巻き戻し時に throttle を無視する誤改修を検知。
        // 前提: elapsed = 30s > expected(3) * 3 = 9s なので throttle 経路まで到達する。
        assert_eq!(should_warn_polling_stall(1000, 970, 1500, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_now_equals_last_seen_returns_none() {
        // now_secs <= last_seen_secs (同時刻) → None (時刻同期問題への保守的扱い)
        assert_eq!(should_warn_polling_stall(1000, 1000, 0, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_zero_expected_returns_some_when_elapsed_positive() {
        // expected_interval_secs = 0, elapsed = 1: 1 <= 0 は偽なので警告発火 → Some(1)
        // 検知装置: expected=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(should_warn_polling_stall(1001, 1000, 0, 0, 60), Some(1));
    }

    #[test]
    fn should_warn_polling_stall_zero_throttle_returns_some_when_stalled() {
        // throttle_secs = 0, elapsed = 30 > 9: saturating_sub(999) = 1 >= 0 → Some(30)
        // 検知装置: throttle=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(should_warn_polling_stall(1000, 970, 999, 3, 0), Some(30));
    }

    #[test]
    fn should_warn_polling_stall_now_secs_max_with_seen_returns_some_huge_elapsed() {
        // now=u64::MAX, last_seen=1: elapsed = u64::MAX - 1 (overflow なし) → Some(u64::MAX - 1)
        // 検知装置: u64 overflow への panic 化 / 不要なキャスト追加による精度損失
        assert_eq!(
            should_warn_polling_stall(u64::MAX, 1, 0, 3, 60),
            Some(u64::MAX - 1)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_first_call_returns_none() {
        // last_seen_secs == 0 は一度も検知されていない: 通知しない
        assert_eq!(should_notify_meeting_inactive(1000, 0, 0, 300, 600), None);
    }

    #[test]
    fn should_notify_meeting_inactive_within_active_range_returns_none() {
        // elapsed = 200s < threshold = 300s: まだアクティブ範囲内なので通知しない
        assert_eq!(should_notify_meeting_inactive(1000, 800, 0, 300, 600), None);
    }

    #[test]
    fn should_notify_meeting_inactive_inactive_returns_some_elapsed() {
        // elapsed = 400s >= threshold = 300s, 未通知 (throttle check = 1000-0=1000 >= 600) → Some(400)
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 0, 300, 600),
            Some(400)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_throttled_returns_none() {
        // elapsed = 400s >= threshold だが now - last_notified = 400s < throttle = 600s → None
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 600, 300, 600),
            None
        );
    }

    #[test]
    fn should_notify_meeting_inactive_now_equals_last_seen_returns_none() {
        // now_secs <= last_seen_secs (同時刻) → None (時刻同期問題への保守的扱い)
        assert_eq!(
            should_notify_meeting_inactive(1000, 1000, 0, 300, 600),
            None
        );
    }

    #[test]
    fn should_notify_meeting_inactive_threshold_boundary_returns_some() {
        // elapsed = 300 == threshold = 300: < 判定のため境界ちょうどで発火する → Some(300)
        // 検知装置: `<` を `<=` に変える誤改修 (境界で発火しない化)
        assert_eq!(
            should_notify_meeting_inactive(1300, 1000, 0, 300, 600),
            Some(300)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_zero_threshold_returns_some_when_elapsed_positive() {
        // inactive_threshold_secs = 0, elapsed = 1: 0 < 0 は偽なので通知発火 → Some(1)
        // 検知装置: threshold=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(
            should_notify_meeting_inactive(1001, 1000, 0, 0, 600),
            Some(1)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_zero_throttle_returns_some_when_inactive() {
        // throttle_secs = 0, elapsed = 400 >= threshold = 300: saturating_sub(999) = 1 >= 0 → Some(400)
        // 検知装置: throttle=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 999, 300, 0),
            Some(400)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_clock_skew_last_notified_after_now_returns_none() {
        // last_notified(1500) > now(1000): saturating_sub → 0 < throttle(600) → None
        // 検知装置: saturating_sub を sub に変える panic 化 / または巻き戻し時 throttle 無視の誤改修
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 1500, 300, 600),
            None
        );
    }

    #[test]
    fn should_notify_meeting_inactive_now_secs_max_with_seen_returns_some_huge_elapsed() {
        // now=u64::MAX, last_seen=1: elapsed = u64::MAX - 1 (overflow なし) → Some(u64::MAX - 1)
        // 検知装置: u64 overflow への panic 化 / 不要なキャスト追加による精度損失
        assert_eq!(
            should_notify_meeting_inactive(u64::MAX, 1, 0, 300, 600),
            Some(u64::MAX - 1)
        );
    }

    #[test]
    fn check_meeting_inactive_for_bundle_returns_none_when_state_uninitialized() {
        // STATE を初期化していないテスト環境で wrapper が安全に None を返す契約を固定。
        // STATE.get() が None のとき early return することで AppHandle や lock を触らず
        // panic / hang を回避する設計を CI で検知する。
        assert_eq!(check_meeting_inactive_for_bundle("us.zoom.xos"), None);
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

    #[test]
    fn parse_throttle_key_to_display_name_returns_app_name_for_known_bundle_id() {
        // 契約: WATCHED_BUNDLE_IDS に登録済みの bundle_id 単独 key は app name を返す
        assert_eq!(
            parse_throttle_key_to_display_name("us.zoom.xos"),
            Some("Zoom".to_string())
        );
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_service_for_browser_key() {
        // 契約: "browser:<bundle_id>:<service>:<host>" 形式は 3 つ目の service セグメントを返す
        assert_eq!(
            parse_throttle_key_to_display_name(
                "browser:com.apple.Safari:Google Meet:meet.google.com"
            ),
            Some("Google Meet".to_string())
        );
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_service_for_window_title_key() {
        // 契約: "window-title:<bundle_id>:<service>" 形式は service セグメントを返す
        assert_eq!(
            parse_throttle_key_to_display_name("window-title:com.apple.Safari:Zoom"),
            Some("Zoom".to_string())
        );
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_none_for_unknown_bundle_id() {
        // 契約: WATCHED_BUNDLE_IDS に存在しない bundle_id 単独は None を返す
        assert_eq!(parse_throttle_key_to_display_name("com.unknown.app"), None);
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_none_for_empty_key() {
        // 契約: 空文字は WATCHED_BUNDLE_IDS にもプレフィックスにも一致せず None を返す
        assert_eq!(parse_throttle_key_to_display_name(""), None);
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_none_for_browser_key_with_empty_service() {
        // 契約: service セグメントが空文字 ("browser:bundle::host") は None を返す
        assert_eq!(
            parse_throttle_key_to_display_name("browser:bundle::host"),
            None
        );
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_service_for_browser_key_with_colon_in_host() {
        // 契約: host に ":" (ポート番号等) が含まれても splitn(3, ':') で parts[1] = service が正しく取れる
        assert_eq!(
            parse_throttle_key_to_display_name(
                "browser:com.apple.Safari:Google Meet:meet.google.com:8443"
            ),
            Some("Google Meet".to_string())
        );
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_none_for_browser_prefix_only() {
        // 契約: "browser:" (prefix のみ、残り空) は splitn で 1 要素のみ → None
        assert_eq!(parse_throttle_key_to_display_name("browser:"), None);
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_none_for_window_title_prefix_only() {
        // 契約: "window-title:" (prefix のみ、残り空) は splitn で 1 要素のみ → None
        assert_eq!(parse_throttle_key_to_display_name("window-title:"), None);
    }

    #[test]
    fn parse_throttle_key_to_display_name_returns_none_for_browser_key_with_only_bundle_id() {
        // 契約: "browser:<bundle_id>" (service 欠落) は splitn で 1 要素のみ → None
        assert_eq!(
            parse_throttle_key_to_display_name("browser:com.apple.Safari"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_empty_and_whitespace_only() {
        assert_eq!(classify_meeting_url(""), None);
        assert_eq!(classify_meeting_url("   "), None);
        assert_eq!(classify_meeting_url("\t\n"), None);
        assert_eq!(classify_meeting_url("\u{3000}"), None);
    }

    #[test]
    fn classify_meeting_url_rejects_non_http_schemes() {
        assert_eq!(classify_meeting_url("file:///path/to/file"), None);
        assert_eq!(
            classify_meeting_url("ftp://meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("ws://meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(classify_meeting_url("chrome://settings/"), None);
        assert_eq!(classify_meeting_url("javascript:alert(1)"), None);
    }

    #[test]
    fn classify_meeting_url_rejects_missing_scheme() {
        assert_eq!(classify_meeting_url("meet.google.com/abc-defg-hij"), None);
        assert_eq!(classify_meeting_url("//meet.google.com/abc-defg-hij"), None);
        assert_eq!(classify_meeting_url("/abc-defg-hij"), None);
    }

    #[test]
    fn classify_meeting_url_rejects_userinfo_in_authority() {
        assert_eq!(
            classify_meeting_url("https://attacker@meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://user:pass@meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com@evil.example.com/abc-defg-hij"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_invalid_port() {
        assert_eq!(
            classify_meeting_url("https://meet.google.com:/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:abc/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:99999/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:65536/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:-1/abc-defg-hij"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_accepts_valid_port() {
        assert_eq!(
            classify_meeting_url("https://meet.google.com:8443/abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
        assert_eq!(
            classify_meeting_url("https://meet.google.com:0/abc-defg-hij"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: "meet.google.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_rejects_ipv6_host_for_meeting_services() {
        assert_eq!(classify_meeting_url("https://[::1]/j/123456789"), None);
        assert_eq!(
            classify_meeting_url("https://[2001:db8::1]/abc-defg-hij"),
            None
        );
        assert_eq!(
            classify_meeting_url("https://[::1]:8443/l/meetup-join/secret"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_double_scheme_separator() {
        assert_eq!(
            classify_meeting_url("https://://meet.google.com/abc-defg-hij"),
            None
        );
        assert_eq!(classify_meeting_url("https://"), None);
        assert_eq!(classify_meeting_url("https:///abc-defg-hij"), None);
    }

    #[test]
    fn classify_meeting_window_title_rejects_leading_whitespace() {
        // strict prefix 一致: 前置空白は reject
        assert_eq!(classify_meeting_window_title(" Meet - abc-defg-hij"), None);
        assert_eq!(classify_meeting_window_title("\tMeet - abc-defg-hij"), None);
        assert_eq!(classify_meeting_window_title("  Zoom Meeting"), None);
        assert_eq!(
            classify_meeting_window_title("\u{3000}Zoom ミーティング"),
            None
        );
    }

    #[test]
    fn classify_meeting_window_title_rejects_case_mismatch() {
        // 大文字小文字は strict: normalize しない
        assert_eq!(classify_meeting_window_title("MEET - abc-defg-hij"), None);
        assert_eq!(classify_meeting_window_title("meet - abc-defg-hij"), None);
        assert_eq!(classify_meeting_window_title("ZOOM Meeting"), None);
        assert_eq!(classify_meeting_window_title("zoom meeting"), None);
        assert_eq!(classify_meeting_window_title("ZOOM ミーティング"), None);
    }

    #[test]
    fn classify_meeting_window_title_rejects_meet_without_space_after_dash() {
        // prefix は "Meet - " (末尾スペース必須)
        assert_eq!(classify_meeting_window_title("Meet -abc-defg-hij"), None);
        assert_eq!(classify_meeting_window_title("Meet-abc-defg-hij"), None);
        assert_eq!(classify_meeting_window_title("Meet  - abc-defg-hij"), None);
    }

    #[test]
    fn classify_meeting_window_title_accepts_meet_with_extra_trailing_content() {
        let gm = Some(MeetingUrlClassification {
            service: "Google Meet".to_string(),
            host: String::new(),
        });
        assert_eq!(
            classify_meeting_window_title("Meet - abc-defg-hij - 追加情報"),
            gm.clone()
        );
        assert_eq!(
            classify_meeting_window_title("Meet \u{2013} 名前 with spaces"),
            gm.clone()
        );
        assert_eq!(classify_meeting_window_title("Meet \u{2014} \u{1F389}"), gm);
    }

    #[test]
    fn classify_meeting_window_title_accepts_zoom_with_unusual_suffix() {
        let zm = Some(MeetingUrlClassification {
            service: "Zoom".to_string(),
            host: String::new(),
        });
        assert_eq!(
            classify_meeting_window_title("Zoom Meeting - paused"),
            zm.clone()
        );
        assert_eq!(
            classify_meeting_window_title("Zoom ミーティング (録画停止中)"),
            zm.clone()
        );
        assert_eq!(
            classify_meeting_window_title("Zoom Meeting\n参加者: 山田"),
            zm
        );
    }

    #[test]
    fn classify_meeting_window_title_handles_only_whitespace_after_meet_dash() {
        // 現仕様: "Meet - " の rest が whitespace のみでも is_empty() == false → Some を返す
        assert_eq!(
            classify_meeting_window_title("Meet -  "),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: String::new(),
            })
        );
        // 現仕様: en-dash prefix の rest = "\t" は非空 → Some を返す
        assert_eq!(
            classify_meeting_window_title("Meet \u{2013} \t"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_rejects_control_characters() {
        // NULL / BOM 前置は prefix 不一致 → None
        assert_eq!(classify_meeting_window_title("\0"), None);
        assert_eq!(
            classify_meeting_window_title("\u{FEFF}Meet - abc-defg-hij"),
            None
        );
        // 現仕様: rest に改行含むが is_empty() == false → Some を返す
        assert_eq!(
            classify_meeting_window_title("Meet - \nabc"),
            Some(MeetingUrlClassification {
                service: "Google Meet".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_returns_webex_for_webex_meeting_with_pipe_suffix() {
        assert_eq!(
            classify_meeting_window_title("Webex Meeting | Acme Inc"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_returns_webex_for_webex_meeting_prefix_only() {
        assert_eq!(
            classify_meeting_window_title("Webex Meeting"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: String::new(),
            })
        );
    }

    #[test]
    fn classify_meeting_window_title_returns_none_for_webex_meeting_not_at_start() {
        assert_eq!(
            classify_meeting_window_title("Microsoft Webex Meeting Tools"),
            None
        );
    }

    #[test]
    fn classify_meeting_window_title_returns_none_for_cisco_webex_without_meeting_keyword() {
        assert_eq!(classify_meeting_window_title("Cisco Webex"), None);
    }

    #[test]
    fn classify_meeting_url_rejects_google_meet_code_path_with_short_first_segment() {
        assert_eq!(
            classify_meeting_url("https://meet.google.com/ab-defg-hij"),
            None,
            "Google Meet path code は first segment 3 桁が必須 (現契約: has_ascii_lowercase_len(first, 3)) = 2 桁 (左境界外側) は reject される必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_rejects_google_meet_code_path_with_long_second_segment() {
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defgh-hij"),
            None,
            "Google Meet path code は second segment 4 桁が必須 (現契約: has_ascii_lowercase_len(second, 4)) = 5 桁 (右境界外側) は reject される必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_rejects_google_meet_code_path_with_long_third_segment() {
        assert_eq!(
            classify_meeting_url("https://meet.google.com/abc-defg-hijk"),
            None,
            "Google Meet path code は third segment 3 桁が必須 (現契約: has_ascii_lowercase_len(third, 3)) = 4 桁 (右境界外側) は reject される必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_accepts_teams_v2_with_meetingjoin_true_in_middle_param_position() {
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/?context=secret&meetingjoin=true"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            }),
            "Teams /v2 経路の query_has_param は & 区切りで全 param を走査する契約 (現契約: query.split('&').any(...)) = meetingjoin が 2 番目以降の位置にあっても accept される必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_accepts_teams_v2_with_duplicate_meetingjoin_keys_when_one_matches() {
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/?meetingjoin=false&meetingjoin=true"),
            Some(MeetingUrlClassification {
                service: "Microsoft Teams".to_string(),
                host: "teams.microsoft.com".to_string(),
            }),
            "Teams /v2 経路の query_has_param は重複 key の場合 1 つでもマッチで true を返す契約 (現契約: query.split('&').any(...)) = meetingjoin=false&meetingjoin=true で後者がマッチして accept される必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_rejects_teams_v2_with_meetingjoin_key_only_no_equals() {
        assert_eq!(
            classify_meeting_url("https://teams.microsoft.com/v2/?meetingjoin"),
            None,
            "Teams /v2 経路の query_has_param は = が無い param を value=\"\" として扱う契約 (現契約: split_once('=').unwrap_or((param, \"\"))) = meetingjoin (= なし) は value=\"\" となり \"true\" と一致せず reject される必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_accepts_zoom_subdomain_label_at_dns_label_max_length_63_bytes() {
        let label = "a".repeat(63);
        let url = format!("https://{}.zoom.us/j/123456789", label);
        let expected_host = format!("{}.zoom.us", label);
        assert_eq!(
            classify_meeting_url(&url),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: expected_host,
            }),
            "is_valid_dns_label は RFC 1035 上限 63 バイトぴったり (現契約: bytes.len() <= 63) を accept する必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_rejects_zoom_subdomain_label_exceeding_dns_label_max_length_64_bytes() {
        let label = "a".repeat(64);
        let url = format!("https://{}.zoom.us/j/123456789", label);
        assert_eq!(
            classify_meeting_url(&url),
            None,
            "is_valid_dns_label は RFC 1035 上限 63 バイト超過 (現契約: bytes.len() <= 63) = 64 バイトは reject する必要がある"
        );
    }

    #[test]
    fn classify_meeting_url_accepts_zoom_subdomain_label_starting_with_digit_per_rfc_1123() {
        assert_eq!(
            classify_meeting_url("https://1company.zoom.us/j/123456789"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "1company.zoom.us".to_string(),
            }),
            "is_valid_dns_label は RFC 1123 仕様で数字始まり label を accept する必要がある (現契約: bytes.first().is_some_and(is_ascii_alphanumeric))"
        );
    }

    #[test]
    fn classify_meeting_url_accepts_zoom_subdomain_label_at_dns_label_minimum_length_1_byte() {
        assert_eq!(
            classify_meeting_url("https://a.zoom.us/j/123456789"),
            Some(MeetingUrlClassification {
                service: "Zoom".to_string(),
                host: "a.zoom.us".to_string(),
            }),
            "is_valid_dns_label は最短 label (1 バイト alphanumeric) を accept する必要がある (現契約: !bytes.is_empty() の左境界内側)"
        );
    }

    #[test]
    fn classify_meeting_url_rejects_zoom_subdomain_label_with_trailing_hyphen_per_rfc_1035() {
        assert_eq!(
            classify_meeting_url("https://my-.zoom.us/j/123456789"),
            None,
            "is_valid_dns_label は RFC 1035 仕様で末尾ハイフン label を reject する必要がある (現契約: bytes.last().is_some_and(is_ascii_alphanumeric))"
        );
    }

    #[test]
    fn classify_meeting_url_rejects_zoom_subdomain_label_with_leading_hyphen_per_rfc_1035() {
        assert_eq!(
            classify_meeting_url("https://-my.zoom.us/j/123456789"),
            None,
            "is_valid_dns_label は RFC 1035 仕様で先頭ハイフン label を reject する必要がある (現契約: bytes.first().is_some_and(is_ascii_alphanumeric))"
        );
    }

    #[test]
    fn meeting_app_detected_payload_debug_output_contains_variant_names_and_all_field_names() {
        let app_variant = MeetingAppDetectedPayload::App {
            bundle_id: "us.zoom.xos".to_string(),
            app_name: "zoom.us".to_string(),
        };
        let browser_variant = MeetingAppDetectedPayload::Browser {
            bundle_id: "com.google.Chrome".to_string(),
            app_name: "Google Chrome".to_string(),
            service: "Google Meet".to_string(),
            url_host: "meet.google.com".to_string(),
            browser_name: "Chrome".to_string(),
        };
        let app_dbg = format!("{app_variant:?}");
        let browser_dbg = format!("{browser_variant:?}");
        assert!(app_dbg.contains("App"));
        assert!(app_dbg.contains("bundle_id"));
        assert!(app_dbg.contains("app_name"));
        assert!(app_dbg.contains("us.zoom.xos"));
        assert!(app_dbg.contains("zoom.us"));
        assert!(browser_dbg.contains("Browser"));
        assert!(browser_dbg.contains("bundle_id"));
        assert!(browser_dbg.contains("app_name"));
        assert!(browser_dbg.contains("service"));
        assert!(browser_dbg.contains("url_host"));
        assert!(browser_dbg.contains("browser_name"));
        assert!(browser_dbg.contains("com.google.Chrome"));
        assert!(browser_dbg.contains("Google Chrome"));
        assert!(browser_dbg.contains("Google Meet"));
        assert!(browser_dbg.contains("meet.google.com"));
        assert!(browser_dbg.contains("Chrome"));
    }

    #[test]
    fn meeting_app_detected_payload_clone_is_deep_and_does_not_mutate_original() {
        let original = MeetingAppDetectedPayload::Browser {
            bundle_id: "com.apple.Safari".to_string(),
            app_name: "Safari".to_string(),
            service: "Microsoft Teams".to_string(),
            url_host: "teams.microsoft.com".to_string(),
            browser_name: "Safari".to_string(),
        };
        let cloned = original.clone();
        let cloned_dbg = format!("{cloned:?}");
        assert!(cloned_dbg.contains("Browser"));
        assert!(cloned_dbg.contains("com.apple.Safari"));
        assert!(cloned_dbg.contains("Safari"));
        assert!(cloned_dbg.contains("Microsoft Teams"));
        assert!(cloned_dbg.contains("teams.microsoft.com"));
        let original = MeetingAppDetectedPayload::App {
            bundle_id: "DIFFERENT".to_string(),
            app_name: "DIFFERENT_NAME".to_string(),
        };
        let _ = original;
        let cloned_dbg_after = format!("{cloned:?}");
        assert!(
            cloned_dbg_after.contains("Browser"),
            "cloned: 再束縛後も Browser variant 維持"
        );
        assert!(
            cloned_dbg_after.contains("com.apple.Safari"),
            "cloned: 元の bundle_id 維持"
        );
        assert!(
            cloned_dbg_after.contains("Microsoft Teams"),
            "cloned: 元の service 維持"
        );
        assert!(
            !cloned_dbg_after.contains("DIFFERENT"),
            "cloned: 再束縛後の値混入なし"
        );
    }

    #[test]
    fn meeting_app_detected_payload_serde_serialize_uses_tagged_enum_with_field_level_rename() {
        let app = MeetingAppDetectedPayload::App {
            bundle_id: "us.zoom.xos".to_string(),
            app_name: "zoom.us".to_string(),
        };
        let json = serde_json::to_value(&app).expect("serialize ok");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 3);
        assert!(obj.contains_key("source"));
        assert!(obj.contains_key("bundleId"));
        assert!(obj.contains_key("appName"));
        assert!(!obj.contains_key("bundle_id"));
        assert!(!obj.contains_key("app_name"));
        assert_eq!(obj["source"], serde_json::json!("app"));
        assert_eq!(obj["bundleId"], serde_json::json!("us.zoom.xos"));
        assert_eq!(obj["appName"], serde_json::json!("zoom.us"));

        let browser = MeetingAppDetectedPayload::Browser {
            bundle_id: "com.google.Chrome".to_string(),
            app_name: "Google Chrome".to_string(),
            service: "Google Meet".to_string(),
            url_host: "meet.google.com".to_string(),
            browser_name: "Chrome".to_string(),
        };
        let json = serde_json::to_value(&browser).expect("serialize ok");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 6);
        assert!(obj.contains_key("source"));
        assert!(obj.contains_key("bundleId"));
        assert!(obj.contains_key("appName"));
        assert!(obj.contains_key("service"));
        assert!(obj.contains_key("urlHost"));
        assert!(obj.contains_key("browserName"));
        assert!(!obj.contains_key("url_host"));
        assert!(!obj.contains_key("browser_name"));
        assert_eq!(obj["source"], serde_json::json!("browser"));
        assert_eq!(obj["bundleId"], serde_json::json!("com.google.Chrome"));
        assert_eq!(obj["appName"], serde_json::json!("Google Chrome"));
        assert_eq!(obj["service"], serde_json::json!("Google Meet"));
        assert_eq!(obj["urlHost"], serde_json::json!("meet.google.com"));
        assert_eq!(obj["browserName"], serde_json::json!("Chrome"));
    }

    #[test]
    fn meeting_url_classification_debug_contains_field_values() {
        let value = MeetingUrlClassification {
            service: "Google Meet".to_string(),
            host: "meet.google.com".to_string(),
        };
        let debug_str = format!("{:?}", value);
        assert!(debug_str.contains("MeetingUrlClassification"));
        assert!(debug_str.contains("service"));
        assert!(debug_str.contains("host"));
        assert!(debug_str.contains("Google Meet"));
        assert!(debug_str.contains("meet.google.com"));
        assert!(
            debug_str.find("service").unwrap() < debug_str.find("host").unwrap(),
            "service が host より先に出現すること (struct 宣言順を反映)"
        );
    }

    #[test]
    fn meeting_url_classification_partial_eq_field_independent_and_clone_distinct() {
        let original = MeetingUrlClassification {
            service: "Zoom".to_string(),
            host: "zoom.us".to_string(),
        };
        assert_eq!(original, original);

        let diff_service = MeetingUrlClassification {
            service: "OTHER".to_string(),
            host: "zoom.us".to_string(),
        };
        assert_ne!(original, diff_service);

        let diff_host = MeetingUrlClassification {
            service: "Zoom".to_string(),
            host: "other.example.com".to_string(),
        };
        assert_ne!(original, diff_host);

        let cloned = original.clone();
        assert_eq!(cloned, original);

        let mut a = MeetingUrlClassification {
            service: "Zoom".to_string(),
            host: "zoom.us".to_string(),
        };
        let mut c = a.clone();
        a.service = "MUTATED_A".to_string();
        c.host = "MUTATED_C.example.com".to_string();
        assert_ne!(a, c);
        assert_ne!(a.service, c.service);
    }

    #[test]
    fn meeting_url_classification_serde_camel_case_json_keys_fixed() {
        let value = MeetingUrlClassification {
            service: "Google Meet".to_string(),
            host: "meet.google.com".to_string(),
        };
        let json = serde_json::to_string(&value).expect("serialize ok");
        assert!(
            json.contains("\"service\":"),
            "service フィールドが JSON に含まれること"
        );
        assert!(
            json.contains("\"host\":"),
            "host フィールドが JSON に含まれること"
        );
        assert!(
            !json.contains("\"Service\""),
            "PascalCase キーが混入しないこと"
        );
        assert!(json.contains("\"Google Meet\""));
        assert!(json.contains("\"meet.google.com\""));
        assert!(
            json.find("\"service\"").unwrap() < json.find("\"host\"").unwrap(),
            "JSON 内で service が host より先に出現すること (struct 宣言順を反映)"
        );
    }

    #[test]
    fn parsed_url_parts_debug_contains_field_values_with_option_some_and_none() {
        let case_a = ParsedUrlParts {
            host: "meet.google.com".to_string(),
            path: "/abc-defg-hij".to_string(),
            query: Some("auth=xyz".to_string()),
        };
        let debug_a = format!("{:?}", case_a);
        assert!(debug_a.contains("ParsedUrlParts"), "struct 名を含む");
        assert!(debug_a.contains("host"), "host フィールド名を含む");
        assert!(debug_a.contains("path"), "path フィールド名を含む");
        assert!(debug_a.contains("query"), "query フィールド名を含む");
        assert!(debug_a.contains("meet.google.com"), "host 値を含む");
        assert!(debug_a.contains("/abc-defg-hij"), "path 値を含む");
        assert!(debug_a.contains("auth=xyz"), "query 内の値を含む");
        assert!(
            debug_a.contains("Some"),
            "Option::Some の Debug format を含む"
        );
        assert!(
            debug_a.find("host").unwrap() < debug_a.find("path").unwrap(),
            "host が path より先に出現する"
        );
        assert!(
            debug_a.find("path").unwrap() < debug_a.find("query").unwrap(),
            "path が query より先に出現する"
        );

        let case_b = ParsedUrlParts {
            host: "teams.microsoft.com".to_string(),
            path: "/".to_string(),
            query: None,
        };
        let debug_b = format!("{:?}", case_b);
        assert!(
            debug_b.contains("None"),
            "Option::None の Debug format を含む"
        );
        assert!(
            !debug_b.contains("auth=xyz"),
            "case A の query 値が混入しないこと"
        );
    }

    #[test]
    fn parsed_url_parts_partial_eq_field_independent_and_option_some_vs_none_distinct() {
        let original = ParsedUrlParts {
            host: "meet.google.com".to_string(),
            path: "/abc-defg-hij".to_string(),
            query: Some("auth=xyz".to_string()),
        };
        assert_eq!(
            original,
            original.clone(),
            "reflexive: 同一インスタンスは等しい"
        );

        let diff_host = ParsedUrlParts {
            host: "other.example.com".to_string(),
            path: "/abc-defg-hij".to_string(),
            query: Some("auth=xyz".to_string()),
        };
        assert_ne!(diff_host, original, "host のみ異なるインスタンスは不等");

        let diff_path = ParsedUrlParts {
            host: "meet.google.com".to_string(),
            path: "/other-path".to_string(),
            query: Some("auth=xyz".to_string()),
        };
        assert_ne!(diff_path, original, "path のみ異なるインスタンスは不等");

        let diff_query = ParsedUrlParts {
            host: "meet.google.com".to_string(),
            path: "/abc-defg-hij".to_string(),
            query: Some("other=val".to_string()),
        };
        assert_ne!(diff_query, original, "query のみ異なるインスタンスは不等");

        let with_none = ParsedUrlParts {
            host: "meet.google.com".to_string(),
            path: "/abc-defg-hij".to_string(),
            query: None,
        };
        assert_ne!(with_none, original, "query=None と query=Some は不等");

        let with_empty = ParsedUrlParts {
            host: "meet.google.com".to_string(),
            path: "/abc-defg-hij".to_string(),
            query: Some("".to_string()),
        };
        assert_ne!(
            with_empty, with_none,
            "query=Some(\"\") と query=None は不等"
        );

        let some_a = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/".to_string(),
            query: Some("a".to_string()),
        };
        let some_b = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/".to_string(),
            query: Some("b".to_string()),
        };
        assert_ne!(
            some_a, some_b,
            "query=Some(\"a\") と query=Some(\"b\") は不等"
        );

        let some_x1 = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/".to_string(),
            query: Some("x".to_string()),
        };
        let some_x2 = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/".to_string(),
            query: Some("x".to_string()),
        };
        assert_eq!(some_x1, some_x2, "query=Some(\"x\") 同士は等しい");

        let none1 = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/".to_string(),
            query: None,
        };
        let none2 = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/".to_string(),
            query: None,
        };
        assert_eq!(none1, none2, "query=None 同士は等しい");
    }

    #[test]
    fn parsed_url_parts_clone_is_deep_and_distinct_after_mutation_including_option() {
        let original = ParsedUrlParts {
            host: "x.com".to_string(),
            path: "/p".to_string(),
            query: Some("k=v".to_string()),
        };

        let mut cloned1 = original.clone();
        assert_eq!(cloned1, original, "clone 直後は元と等しい");
        cloned1.host = "changed.com".to_string();
        assert_ne!(cloned1, original, "host 変更後は元と不等");

        let mut cloned2 = original.clone();
        cloned2.path = "/other".to_string();
        assert_ne!(cloned2, original, "path 変更後は元と不等");

        let mut cloned3 = original.clone();
        cloned3.query = Some("k=other".to_string());
        assert_ne!(cloned3, original, "query を別 Some 値に変更後は元と不等");

        let mut cloned4 = original.clone();
        cloned4.query = None;
        assert_ne!(cloned4, original, "query を None に変更後は元と不等");

        assert_eq!(
            original.query,
            Some("k=v".to_string()),
            "元の query は Some(\"k=v\") のまま不変"
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_personal_room_on_root_host() {
        assert_eq!(
            classify_meeting_url("https://webex.com/meet/john"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_personal_room_on_subdomain_host() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/meet/jane"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webex_host_without_meet_path() {
        assert_eq!(classify_meeting_url("https://webex.com/about"), None);
    }

    #[test]
    fn classify_meeting_url_returns_none_for_non_webex_host_with_meet_path() {
        assert_eq!(
            classify_meeting_url("https://fake-webex.example.com/meet/x"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webex_with_empty_meet_segment() {
        assert_eq!(classify_meeting_url("https://webex.com/meet/"), None);
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_jphp_on_subdomain() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/acme/j.php?MTID=mabc123"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_jphp_on_root_host() {
        assert_eq!(
            classify_meeting_url("https://webex.com/webex/j.php?MTID=mxyz"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_jphp_with_trailing_slash() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/acme/j.php/?MTID=mxyz"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webex_jphp_without_mtid() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/acme/j.php"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webex_jphp_with_empty_mtid() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/acme/j.php?MTID="),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_non_webex_host_with_jphp() {
        assert_eq!(
            classify_meeting_url("https://fake-webex.example.com/acme/j.php?MTID=mxyz"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webex_jphp_with_extra_path_segment() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/acme/foo/j.php?MTID=mxyz"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_wbxmjs_with_meeting_segment() {
        assert_eq!(
            classify_meeting_url(
                "https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/m123abc"
            ),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_wbxmjs_with_extra_token_segment() {
        assert_eq!(
            classify_meeting_url(
                "https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/m123abc"
            ),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_wbxmjs_with_trailing_slash() {
        assert_eq!(
            classify_meeting_url(
                "https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/m123abc/"
            ),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_wbxmjs_without_meeting_segment() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/wbxmjs/joinservice/sites/acme"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_wbxmjs_wrong_path_prefix() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/wbxmjs/foo/bar"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_non_webex_host_with_wbxmjs() {
        assert_eq!(
            classify_meeting_url(
                "https://fake-webex.example.com/wbxmjs/joinservice/sites/acme/meeting/m123abc"
            ),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_wbxmjs_with_empty_site_segment() {
        assert_eq!(
            classify_meeting_url(
                "https://acme.webex.com/wbxmjs/joinservice/sites//meeting/m123abc"
            ),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_webappng_info_url() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/webappng/sites/acme/meeting/info/m123abc"),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_webex_for_webappng_with_trailing_slash() {
        assert_eq!(
            classify_meeting_url(
                "https://acme.webex.com/webappng/sites/acme/meeting/info/m123abc/"
            ),
            Some(MeetingUrlClassification {
                service: "Webex".to_string(),
                host: "acme.webex.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webappng_without_token() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/webappng/sites/acme/meeting/info"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webappng_with_non_info_action() {
        assert_eq!(
            classify_meeting_url(
                "https://acme.webex.com/webappng/sites/acme/meeting/download/m123abc"
            ),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webappng_without_meeting_keyword() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/webappng/sites/acme/foo/info/m123abc"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_non_webex_host_with_webappng() {
        assert_eq!(
            classify_meeting_url(
                "https://fake-webex.example.com/webappng/sites/acme/meeting/info/m123abc"
            ),
            None
        );
    }

    #[test]
    fn classify_meeting_url_returns_none_for_webappng_with_empty_site_segment() {
        assert_eq!(
            classify_meeting_url("https://acme.webex.com/webappng/sites//meeting/info/m123abc"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_whereby_apex_room() {
        assert_eq!(
            classify_meeting_url("https://whereby.com/team-meeting"),
            Some(MeetingUrlClassification {
                service: "Whereby".to_string(),
                host: "whereby.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_whereby_subdomain_room() {
        assert_eq!(
            classify_meeting_url("https://mycompany.whereby.com/quick-call"),
            Some(MeetingUrlClassification {
                service: "Whereby".to_string(),
                host: "mycompany.whereby.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_blacklist_about() {
        assert_eq!(classify_meeting_url("https://whereby.com/about"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_blacklist_pricing() {
        assert_eq!(classify_meeting_url("https://whereby.com/pricing"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_blacklist_download() {
        assert_eq!(classify_meeting_url("https://whereby.com/download"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_blacklist_app() {
        assert_eq!(classify_meeting_url("https://whereby.com/app"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_blacklist_for_teams() {
        assert_eq!(classify_meeting_url("https://whereby.com/for-teams"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_blacklist_developers() {
        assert_eq!(classify_meeting_url("https://whereby.com/developers"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_extra_segment() {
        assert_eq!(
            classify_meeting_url("https://whereby.com/team-room/extra"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_dns_label_spoofing() {
        assert_eq!(classify_meeting_url("https://fake-whereby.com/room"), None);
    }

    #[test]
    fn classify_meeting_url_whereby_rejects_empty_room_name() {
        assert_eq!(classify_meeting_url("https://whereby.com/"), None);
    }

    #[test]
    fn classify_meeting_url_goto_apex_room() {
        assert_eq!(
            classify_meeting_url("https://meet.goto.com/team-standup"),
            Some(MeetingUrlClassification {
                service: "GoToMeeting".to_string(),
                host: "meet.goto.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_goto_subdomain_room() {
        assert_eq!(
            classify_meeting_url("https://acme.meet.goto.com/quick-call"),
            Some(MeetingUrlClassification {
                service: "GoToMeeting".to_string(),
                host: "acme.meet.goto.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_goto_rejects_blacklist_about() {
        assert_eq!(classify_meeting_url("https://meet.goto.com/about"), None);
    }

    #[test]
    fn classify_meeting_url_goto_rejects_blacklist_pricing() {
        assert_eq!(classify_meeting_url("https://meet.goto.com/pricing"), None);
    }

    #[test]
    fn classify_meeting_url_goto_rejects_extra_segment() {
        assert_eq!(
            classify_meeting_url("https://meet.goto.com/team-room/extra"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_goto_rejects_dns_label_spoofing() {
        assert_eq!(
            classify_meeting_url("https://fake-meet.goto.com/room"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_goto_rejects_empty_room_name() {
        assert_eq!(classify_meeting_url("https://meet.goto.com/"), None);
    }

    #[test]
    fn classify_meeting_url_recognizes_goto_legacy_join_url() {
        let result = classify_meeting_url("https://global.gotomeeting.com/join/123456789");
        assert_eq!(
            result,
            Some(MeetingUrlClassification {
                service: "GoToMeeting".to_string(),
                host: "global.gotomeeting.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_recognizes_goto_legacy_join_url_with_trailing_slash() {
        let result = classify_meeting_url("https://global.gotomeeting.com/join/987654321/");
        assert_eq!(
            result,
            Some(MeetingUrlClassification {
                service: "GoToMeeting".to_string(),
                host: "global.gotomeeting.com".to_string(),
            })
        );
    }

    #[test]
    fn classify_meeting_url_rejects_goto_legacy_non_numeric_id() {
        assert_eq!(
            classify_meeting_url("https://global.gotomeeting.com/join/abc123def"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_goto_legacy_short_id() {
        assert_eq!(
            classify_meeting_url("https://global.gotomeeting.com/join/12345678"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_goto_legacy_long_id() {
        assert_eq!(
            classify_meeting_url("https://global.gotomeeting.com/join/1234567890"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_goto_legacy_non_join_path() {
        assert_eq!(
            classify_meeting_url("https://global.gotomeeting.com/about"),
            None
        );
    }

    #[test]
    fn classify_meeting_url_rejects_goto_legacy_subdomain_spoofing() {
        assert_eq!(
            classify_meeting_url("https://fake.global.gotomeeting.com/join/123456789"),
            None
        );
    }
}
