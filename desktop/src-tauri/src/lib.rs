mod app_detection;
mod app_detection_google_meet;
mod app_detection_goto;
mod app_detection_inactive_decision;
#[cfg(target_os = "macos")]
mod app_detection_macos;
mod app_detection_meeting_classifier;
mod app_detection_notification;
mod app_detection_teams;
mod app_detection_throttle_key;
mod app_detection_url_helpers;
mod app_detection_webex;
mod app_detection_whereby;
mod app_detection_zoom;
mod apple_speech;
#[cfg(target_os = "macos")]
mod apple_speech_macos;
mod audio;
mod audio_event;
mod audio_resample;
mod audio_sample_helpers;
mod audio_silence;
mod audio_traits;
mod audio_utils;
mod cloud_whisper;
mod cloud_whisper_errors;
mod datetime_fmt;
mod elevenlabs_realtime;
mod elevenlabs_realtime_ws_task;
mod markdown;
mod openai_realtime;
mod openai_realtime_ws_task;
mod realtime_audio_command;
mod realtime_audio_helpers;
mod realtime_error_helpers;
mod realtime_reader_task;
mod realtime_ws_helpers;
mod secret_store;
mod secret_store_commands;
mod session;
mod session_audio_assets;
mod session_commands;
mod session_commands_helpers;
mod session_commands_list;
mod session_commands_read;
mod session_manager;
mod session_manager_persist;
mod session_manager_types;
mod session_store;
mod session_store_list;
mod session_store_parse;
mod session_store_render;
mod session_store_types;
mod settings;
mod settings_commands;
mod settings_permission;
mod speaker_normalize;
mod system_audio;
mod system_audio_format;
mod system_audio_pcm;
mod transcript_bridge;
mod transcription_commands;
mod transcription_commands_helpers;
mod transcription_commands_model;
mod transcription_emission;
mod transcription_error_payload;
mod transcription_events;
mod transcription_manager;
mod transcription_model_manager;
mod transcription_panic_guard;
mod transcription_traits;
mod transcription_types;
mod transcription_whisper_local;
mod transcription_whisper_stream;
mod transcription_worker_loop;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    utils::config::Color,
    Emitter, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const MEETING_PROMPT_WINDOW_LABEL: &str = "meeting-prompt";
const LIVE_CAPTION_WINDOW_LABEL: &str = "live-caption";
const RING_LIGHT_WINDOW_LABEL: &str = "ring-light";
const SETTINGS_WINDOW_REQUEST_EVENT: &str = "meet-jerky-open-settings-category";
const MEETING_START_REQUEST_EVENT: &str = "meet-jerky-start-recording-requested";
#[cfg(debug_assertions)]
const CONTROLLER_WINDOW_LABEL: &str = "controller";
#[cfg(debug_assertions)]
const CONTROLLER_WIDTH: f64 = 460.0;
#[cfg(debug_assertions)]
const CONTROLLER_HEIGHT: f64 = 720.0;
const SETTINGS_WINDOW_WIDTH: f64 = 820.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 560.0;
const MEETING_PROMPT_WIDTH: f64 = 560.0;
const MEETING_PROMPT_HEIGHT: f64 = 280.0;
const MAIN_WINDOW_WIDTH: f64 = 328.0;
const MAIN_WINDOW_HEIGHT: f64 = 560.0;
const MAIN_WINDOW_MENU_BAR_FALLBACK_Y_OFFSET: f64 = 28.0;
const MAIN_WINDOW_FALLBACK_RIGHT_INSET: f64 = 12.0;
const LIVE_CAPTION_WIDTH: f64 = 900.0;
const LIVE_CAPTION_HEIGHT: f64 = 360.0;
const RING_LIGHT_FALLBACK_WIDTH: f64 = 1280.0;
const RING_LIGHT_FALLBACK_HEIGHT: f64 = 800.0;

pub(crate) fn install_rustls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        if let Err(err) = rustls::crypto::ring::default_provider().install_default() {
            eprintln!("[rustls] failed to install ring crypto provider: {err:?}");
        }
    }
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "録音パネルを表示", true, None::<&str>)?;
    let start_recording_item =
        MenuItem::with_id(app, "start-recording", "録音を開始", true, None::<&str>)?;
    let live_caption_item = MenuItem::with_id(
        app,
        "live-caption",
        "ライブ文字起こしを表示",
        true,
        None::<&str>,
    )?;
    let open_settings_item = MenuItem::with_id(
        app,
        "settings-general",
        "設定を開く",
        true,
        None::<&str>,
    )?;
    let settings_detection_item =
        MenuItem::with_id(app, "settings-detection", "検出", true, None::<&str>)?;
    let settings_audio_item = MenuItem::with_id(app, "settings-audio", "音声", true, None::<&str>)?;
    let settings_transcription_item = MenuItem::with_id(
        app,
        "settings-transcription",
        "文字起こし",
        true,
        None::<&str>,
    )?;
    let settings_ai_minutes_item =
        MenuItem::with_id(app, "settings-ai-minutes", "AI議事録", true, None::<&str>)?;
    let settings_privacy_item =
        MenuItem::with_id(app, "settings-privacy", "プライバシー", true, None::<&str>)?;
    let settings_submenu = Submenu::with_items(
        app,
        "設定ショートカット",
        true,
        &[
            &settings_detection_item,
            &settings_audio_item,
            &settings_transcription_item,
            &settings_ai_minutes_item,
            &settings_privacy_item,
        ],
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &start_recording_item,
            &live_caption_item,
            &PredefinedMenuItem::separator(app)?,
            &open_settings_item,
            &settings_submenu,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let icon = Image::from_path("icons/32x32.png")?;

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Meet Jerky")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    position_main_window_under_menu_bar(app_handle, &window);
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "start-recording" => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    position_main_window_under_menu_bar(app_handle, &window);
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app_handle.emit(
                    MEETING_START_REQUEST_EVENT,
                    serde_json::json!({
                        "source": "menu-bar",
                        "sourceLabel": "メニューバー"
                    }),
                );
            }
            "live-caption" => {
                let _ = set_live_caption_window_visible(app_handle.clone(), true);
            }
            "settings-general" => {
                let _ = show_settings_window(app_handle.clone(), Some("general".to_string()));
            }
            "settings-detection" => {
                let _ = show_settings_window(app_handle.clone(), Some("detection".to_string()));
            }
            "settings-audio" => {
                let _ = show_settings_window(app_handle.clone(), Some("audio".to_string()));
            }
            "settings-transcription" => {
                let _ = show_settings_window(app_handle.clone(), Some("transcription".to_string()));
            }
            "settings-ai-minutes" => {
                let _ = show_settings_window(app_handle.clone(), Some("aiMinutes".to_string()));
            }
            "settings-privacy" => {
                let _ = show_settings_window(app_handle.clone(), Some("privacy".to_string()));
            }
            "quit" => {
                app_handle.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app_handle = tray.app_handle();
                if let Some(window) = app_handle.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        position_main_window_under_menu_bar(app_handle, &window);
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn setup_overlay_windows(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(
        app,
        MEETING_PROMPT_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=meeting-prompt".into()),
    )
    .title("Meet Jerky Recording")
    .inner_size(MEETING_PROMPT_WIDTH, MEETING_PROMPT_HEIGHT)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .build()?;

    WebviewWindowBuilder::new(
        app,
        LIVE_CAPTION_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=live-caption".into()),
    )
    .title("Meet Jerky Live Caption")
    .inner_size(LIVE_CAPTION_WIDTH, LIVE_CAPTION_HEIGHT)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .build()?;

    WebviewWindowBuilder::new(
        app,
        RING_LIGHT_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=ring-light".into()),
    )
    .title("Meet Jerky Recording Indicator")
    .inner_size(RING_LIGHT_FALLBACK_WIDTH, RING_LIGHT_FALLBACK_HEIGHT)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false)
    .build()?;

    Ok(())
}

fn setup_settings_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=settings&category=general".into()),
    )
    .title("Meet Jerky Settings")
    .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    .min_inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    .center()
    .decorations(false)
    .resizable(true)
    .visible(false)
    .skip_taskbar(true)
    .build()?;

    Ok(())
}

/// デバッグ用コントローラー窓を生成する。dev ビルド限定で、起動時に中央へ可視表示する。
/// 各オーバーレイUIを本番経路で任意に発火させて単体検証するためのハーネス。
#[cfg(debug_assertions)]
fn setup_controller_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(
        app,
        CONTROLLER_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=controller".into()),
    )
    .title("Meet Jerky Controller (Debug)")
    .inner_size(CONTROLLER_WIDTH, CONTROLLER_HEIGHT)
    .center()
    .resizable(true)
    .always_on_top(true)
    .visible(true)
    .build()?;

    Ok(())
}

/// MEETJERKY_DEBUG_AUTOSHOW で指定したオーバーレイ窓を、起動直後に本番経路で自動表示する。
/// クリック不要で配置ロジックを発火させ、ログ＋外部オラクルで自走検証するためのフック。
#[cfg(debug_assertions)]
fn spawn_debug_autoshow(app: &tauri::App) {
    let Ok(target) = std::env::var("MEETJERKY_DEBUG_AUTOSHOW") else {
        return;
    };
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        // webview とネイティブ窓が生成され切るのを待ってから発火する。
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let dispatch = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let res = match target.as_str() {
                "live-caption" => set_live_caption_window_visible(dispatch.clone(), true),
                "meeting-prompt" => set_meeting_prompt_window_visible(dispatch.clone(), true),
                "ring-light" => set_ring_light_visible(dispatch.clone(), true),
                other => {
                    eprintln!("[autoshow] 未知のターゲット: {other}");
                    Ok(())
                }
            };
            match res {
                Ok(()) => eprintln!("[autoshow] done target={target}"),
                Err(e) => eprintln!("[autoshow] failed target={target}: {e}"),
            }
        });
    });
}

fn current_monitor_or_primary(app: &tauri::AppHandle) -> tauri::Result<Option<Monitor>> {
    if let Ok(cursor_position) = app.cursor_position() {
        if let Some(monitor) = app.monitor_from_point(cursor_position.x, cursor_position.y)? {
            return Ok(Some(monitor));
        }
    }

    app.primary_monitor()
}

fn meeting_monitor_or_current_or_primary(app: &tauri::AppHandle) -> tauri::Result<Option<Monitor>> {
    // デバッグ: scale 2.0 の主モニタ等、狙ったモニタで配置を検証するための強制指定。
    #[cfg(debug_assertions)]
    if std::env::var("MEETJERKY_DEBUG_FORCE_PRIMARY").is_ok() {
        return app.primary_monitor();
    }
    if let Some((x, y)) = app_detection::latest_meeting_window_center() {
        if let Some(monitor) = app.monitor_from_point(x, y)? {
            return Ok(Some(monitor));
        }
    }

    current_monitor_or_primary(app)
}

/// モニタの論理(ポイント)フレーム (x, y, width, height) を返す。
/// macOS のグローバル座標は論理で統一されており、混在DPIマルチモニタでも一貫する。
/// Tauri は物理を `論理 * そのモニタの scale` で構成するため、物理を scale で割れば論理に戻せる。
fn monitor_logical_frame(monitor: &Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    (
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

#[cfg(target_os = "macos")]
mod macos_status_window {
    extern "C" {
        fn meet_jerky_status_anchor_position(
            window_width: f64,
            window_height: f64,
            right_inset: f64,
            top_offset: f64,
            out_x: *mut f64,
            out_y: *mut f64,
        ) -> bool;
    }

    pub fn anchor_position(
        window_width: f64,
        window_height: f64,
        right_inset: f64,
        top_offset: f64,
    ) -> Option<(f64, f64)> {
        let mut x = 0.0;
        let mut y = 0.0;
        let ok = unsafe {
            meet_jerky_status_anchor_position(
                window_width,
                window_height,
                right_inset,
                top_offset,
                &mut x,
                &mut y,
            )
        };
        ok.then_some((x, y))
    }
}

#[cfg(target_os = "macos")]
fn native_status_anchor_position(window_width: f64, window_height: f64) -> Option<(f64, f64)> {
    macos_status_window::anchor_position(
        window_width,
        window_height,
        MAIN_WINDOW_FALLBACK_RIGHT_INSET,
        MAIN_WINDOW_MENU_BAR_FALLBACK_Y_OFFSET,
    )
}

#[cfg(not(target_os = "macos"))]
fn native_status_anchor_position(_window_width: f64, _window_height: f64) -> Option<(f64, f64)> {
    None
}

fn position_main_window_under_menu_bar(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let window_size = window.outer_size().ok();
    let fallback_monitor = current_monitor_or_primary(app).ok().flatten();
    let fallback_scale = fallback_monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let window_width = window_size
        .map(|s| s.width as f64)
        .unwrap_or(MAIN_WINDOW_WIDTH * fallback_scale);
    let window_height = window_size
        .map(|s| s.height as f64)
        .unwrap_or(MAIN_WINDOW_HEIGHT * fallback_scale);

    if let Some((x, y)) = native_status_anchor_position(window_width, window_height) {
        let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        return;
    }

    let Some(monitor) = fallback_monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_width = window_width.min(monitor_size.width as f64).max(1.0);
    let window_height = window_height.min(monitor_size.height as f64).max(1.0);
    let mx = monitor_position.x as f64;
    let my = monitor_position.y as f64;
    let mw = monitor_size.width as f64;
    let mh = monitor_size.height as f64;
    let target_x = mx + mw - window_width - (MAIN_WINDOW_FALLBACK_RIGHT_INSET * scale);
    let target_y = my + (MAIN_WINDOW_MENU_BAR_FALLBACK_Y_OFFSET * scale);
    let x = target_x.clamp(mx, mx + (mw - window_width).max(0.0));
    let y = target_y.clamp(my, my + (mh - window_height).max(0.0));

    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn position_window_top_center(
    app: &tauri::AppHandle,
    label: &str,
    logical_width: f64,
    logical_height: f64,
) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(Some(monitor)) = meeting_monitor_or_current_or_primary(app) else {
        return;
    };
    let (mx, my, mw, mh) = monitor_logical_frame(&monitor);
    let visible_width = logical_width.min(mw).max(1.0);
    let visible_height = logical_height.min(mh).max(1.0);
    let x = (mx + (mw - visible_width) / 2.0).clamp(mx, mx + (mw - visible_width).max(0.0));
    let _ = window.set_size(LogicalSize::new(visible_width, visible_height));
    let _ = window.set_position(LogicalPosition::new(x, my));
}

fn position_window_bottom_center(
    app: &tauri::AppHandle,
    label: &str,
    logical_width: f64,
    logical_height: f64,
    bottom_offset: u32,
) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(Some(monitor)) = meeting_monitor_or_current_or_primary(app) else {
        return;
    };
    let (mx, my, mw, mh) = monitor_logical_frame(&monitor);
    let visible_width = logical_width.min(mw).max(1.0);
    let visible_height = logical_height.min(mh).max(1.0);
    let x = (mx + (mw - visible_width) / 2.0).clamp(mx, mx + (mw - visible_width).max(0.0));
    let target_y = my + mh - visible_height - bottom_offset as f64;
    let y = target_y.clamp(my, my + (mh - visible_height).max(0.0));
    let _ = window.set_size(LogicalSize::new(visible_width, visible_height));
    let _ = window.set_position(LogicalPosition::new(x, y));
}

fn normalize_settings_category(category: Option<&str>) -> &'static str {
    match category {
        Some("detection") => "detection",
        Some("audio") => "audio",
        Some("transcription") => "transcription",
        Some("aiMinutes") => "aiMinutes",
        Some("privacy") => "privacy",
        _ => "general",
    }
}

#[tauri::command]
fn set_meeting_prompt_window_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MEETING_PROMPT_WINDOW_LABEL) else {
        return Err("会議検知通知ウィンドウが見つかりません".to_string());
    };
    if visible {
        position_window_top_center(
            &app,
            MEETING_PROMPT_WINDOW_LABEL,
            MEETING_PROMPT_WIDTH,
            MEETING_PROMPT_HEIGHT,
        );
        window
            .show()
            .map_err(|e| format!("会議検知通知ウィンドウを表示できません: {e}"))?;
    } else {
        window
            .hide()
            .map_err(|e| format!("会議検知通知ウィンドウを隠せません: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn show_settings_window(app: tauri::AppHandle, category: Option<String>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) else {
        return Err("設定ウィンドウが見つかりません".to_string());
    };
    let category = normalize_settings_category(category.as_deref());
    window
        .show()
        .map_err(|e| format!("設定ウィンドウを表示できません: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("設定ウィンドウにフォーカスできません: {e}"))?;
    window
        .emit(SETTINGS_WINDOW_REQUEST_EVENT, category)
        .map_err(|e| format!("設定カテゴリを切り替えられません: {e}"))?;
    Ok(())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err("メインウィンドウが見つかりません".to_string());
    };
    position_main_window_under_menu_bar(&app, &window);
    window
        .show()
        .map_err(|e| format!("メインウィンドウを表示できません: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("メインウィンドウにフォーカスできません: {e}"))?;
    Ok(())
}

#[tauri::command]
fn set_live_caption_window_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LIVE_CAPTION_WINDOW_LABEL) else {
        return Err("ライブ文字起こしウィンドウが見つかりません".to_string());
    };
    if visible {
        position_window_bottom_center(
            &app,
            LIVE_CAPTION_WINDOW_LABEL,
            LIVE_CAPTION_WIDTH,
            LIVE_CAPTION_HEIGHT,
            0,
        );
        let was_visible = window
            .is_visible()
            .map_err(|e| format!("ライブ文字起こしウィンドウの表示状態を確認できません: {e}"))?;
        if !was_visible {
            let _ = window.emit(crate::transcription_events::LIVE_CAPTION_RESET_EVENT, ());
        }
        window
            .show()
            .map_err(|e| format!("ライブ文字起こしウィンドウを表示できません: {e}"))?;
    } else {
        window
            .hide()
            .map_err(|e| format!("ライブ文字起こしウィンドウを隠せません: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn set_ring_light_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(RING_LIGHT_WINDOW_LABEL) else {
        return Err("リングライトウィンドウが見つかりません".to_string());
    };
    if let Ok(Some(monitor)) = meeting_monitor_or_current_or_primary(&app) {
        window
            .set_position(PhysicalPosition::new(
                monitor.position().x,
                monitor.position().y,
            ))
            .map_err(|e| format!("リングライトウィンドウの位置を更新できません: {e}"))?;
        window
            .set_size(PhysicalSize::new(
                monitor.size().width,
                monitor.size().height,
            ))
            .map_err(|e| format!("リングライトウィンドウのサイズを更新できません: {e}"))?;
    }
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("リングライトウィンドウをクリック透過にできません: {e}"))?;
    if visible {
        window
            .show()
            .map_err(|e| format!("リングライトウィンドウを表示できません: {e}"))?;
    } else {
        window
            .hide()
            .map_err(|e| format!("リングライトウィンドウを隠せません: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_rustls_crypto_provider();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(audio::AudioStateHandle::new())
        .manage(transcription_manager::TranscriptionStateHandle::new())
        .manage(settings::SettingsStateHandle::new())
        .manage(std::sync::Arc::new(session_manager::SessionManager::new()))
        .invoke_handler(tauri::generate_handler![
            audio::list_audio_devices,
            audio::start_recording,
            audio::stop_recording,
            system_audio::start_system_audio,
            system_audio::stop_system_audio,
            transcription_commands_model::list_models,
            transcription_commands_model::is_model_downloaded,
            transcription_commands_model::download_model,
            transcription_commands::start_transcription,
            transcription_commands::stop_transcription,
            settings_commands::get_settings,
            settings_commands::update_settings,
            settings_commands::get_default_output_directory,
            settings_commands::select_output_directory,
            settings_permission::check_microphone_permission,
            settings_permission::check_screen_recording_permission,
            secret_store_commands::set_openai_api_key,
            secret_store_commands::clear_openai_api_key,
            secret_store_commands::has_openai_api_key,
            secret_store_commands::set_elevenlabs_api_key,
            secret_store_commands::clear_elevenlabs_api_key,
            secret_store_commands::has_elevenlabs_api_key,
            session_commands::start_session,
            session_commands::finalize_and_save_session,
            session_commands::discard_session,
            session_commands_list::list_session_summaries_cmd,
            session_commands_read::read_session_content_cmd,
            session_audio_assets::get_session_audio_assets_cmd,
            app_detection::take_latest_meeting_detection,
            show_settings_window,
            show_main_window,
            set_meeting_prompt_window_visible,
            set_live_caption_window_visible,
            set_ring_light_visible,
            #[cfg(debug_assertions)]
            app_detection::debug_emit_meeting_detected,
        ])
        .setup(|app| {
            setup_tray(app)?;
            setup_settings_window(app)?;
            setup_overlay_windows(app)?;
            #[cfg(debug_assertions)]
            setup_controller_window(app)?;
            #[cfg(debug_assertions)]
            spawn_debug_autoshow(app);
            // 会議アプリの起動検知を開始する。macOS 以外では noop。
            app_detection::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL && matches!(event, WindowEvent::Focused(false)) {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn rustls_crypto_provider_installation_is_idempotent() {
        super::install_rustls_crypto_provider();
        super::install_rustls_crypto_provider();

        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
