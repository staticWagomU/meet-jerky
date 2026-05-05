//! 会議アプリ検知 (NSWorkspace + AppleScript) の macOS 固有 FFI ブリッジ実装。
//!
//! `app_detection.rs` から `#[cfg(target_os = "macos")]` の `mod macos` を切り出し、
//! Swift 側 (meet_jerky_app_detection_start) との extern "C" 境界を集約する。
//! caller は `app_detection.rs::start` の `#[cfg(target_os = "macos")]` ブロック内のみ。

#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void, CStr, CString};

use crate::app_detection::{handle_browser_url_detection, handle_detection, WATCHED_BUNDLE_IDS};

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

pub(crate) fn start_detection() {
    // 監視対象を JSON 配列にして Swift に渡す
    let bundle_ids: Vec<&str> = WATCHED_BUNDLE_IDS.iter().map(|(id, _, _)| *id).collect();
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
