mod app_detection;
mod apple_speech;
mod audio;
mod cloud_whisper;
mod cloud_whisper_errors;
mod datetime_fmt;
mod elevenlabs_realtime;
mod markdown;
mod openai_realtime;
mod secret_store;
mod session;
mod session_commands;
mod session_manager;
mod session_store;
mod settings;
mod system_audio;
mod transcript;
mod transcript_bridge;
mod transcription;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const MEETING_PROMPT_WINDOW_LABEL: &str = "meeting-prompt";
const LIVE_CAPTION_WINDOW_LABEL: &str = "live-caption";
const RING_LIGHT_WINDOW_LABEL: &str = "ring-light";
const MEETING_PROMPT_WIDTH: f64 = 440.0;
const MEETING_PROMPT_HEIGHT: f64 = 128.0;
const LIVE_CAPTION_WIDTH: f64 = 460.0;
const LIVE_CAPTION_HEIGHT: f64 = 104.0;
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
    let show_item = MenuItem::with_id(app, "show", "表示", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let icon = Image::from_path("icons/32x32.png")?;

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .tooltip("meet-jerky")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
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
                rect,
                ..
            } = event
            {
                let app_handle = tray.app_handle();
                if let Some(window) = app_handle.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        // Extract physical position from the tray icon rect
                        let (tray_x, tray_y) = match rect.position {
                            Position::Physical(pos) => (pos.x as f64, pos.y as f64),
                            Position::Logical(pos) => (pos.x, pos.y),
                        };
                        let (tray_w, tray_h) = match rect.size {
                            Size::Physical(size) => (size.width as f64, size.height as f64),
                            Size::Logical(size) => (size.width, size.height),
                        };
                        let window_width =
                            window.outer_size().map(|s| s.width as f64).unwrap_or(400.0);

                        // Position the window centered below the tray icon
                        let x = tray_x + (tray_w / 2.0) - (window_width / 2.0);
                        let y = tray_y + tray_h;

                        let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
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
        WebviewUrl::App("index.html".into()),
    )
    .title("meet-jerky recording prompt")
    .inner_size(MEETING_PROMPT_WIDTH, MEETING_PROMPT_HEIGHT)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .focused(false)
    .visible(false)
    .build()?;

    WebviewWindowBuilder::new(
        app,
        LIVE_CAPTION_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("meet-jerky live caption")
    .inner_size(LIVE_CAPTION_WIDTH, LIVE_CAPTION_HEIGHT)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .focused(false)
    .visible(false)
    .build()?;

    WebviewWindowBuilder::new(
        app,
        RING_LIGHT_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("meet-jerky ring light")
    .inner_size(RING_LIGHT_FALLBACK_WIDTH, RING_LIGHT_FALLBACK_HEIGHT)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false)
    .build()?;

    Ok(())
}

fn position_window_top_center(app: &tauri::AppHandle, label: &str, top_offset: i32) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };

    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let x =
        monitor_position.x + ((monitor_size.width.saturating_sub(window_size.width)) / 2) as i32;
    let y = monitor_position.y + top_offset;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn position_window_bottom_center(app: &tauri::AppHandle, label: &str, bottom_offset: u32) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };

    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let x =
        monitor_position.x + ((monitor_size.width.saturating_sub(window_size.width)) / 2) as i32;
    let y = monitor_position.y
        + monitor_size
            .height
            .saturating_sub(window_size.height)
            .saturating_sub(bottom_offset) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub(crate) fn show_meeting_prompt_window(app: &tauri::AppHandle) {
    position_window_top_center(app, MEETING_PROMPT_WINDOW_LABEL, 44);
    if let Some(window) = app.get_webview_window(MEETING_PROMPT_WINDOW_LABEL) {
        let _ = window.show();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn set_live_caption_window_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    position_window_bottom_center(&app, LIVE_CAPTION_WINDOW_LABEL, 56);
    let Some(window) = app.get_webview_window(LIVE_CAPTION_WINDOW_LABEL) else {
        return Err("ライブ文字起こしウィンドウが見つかりません".to_string());
    };
    if visible {
        let was_visible = window
            .is_visible()
            .map_err(|e| format!("ライブ文字起こしウィンドウの表示状態を確認できません: {e}"))?;
        if !was_visible {
            let _ = window.emit("live-caption-reset", ());
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
    if let Ok(Some(monitor)) = app.primary_monitor() {
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
        .manage(transcription::TranscriptionStateHandle::new())
        .manage(settings::SettingsStateHandle::new())
        .manage(std::sync::Arc::new(session_manager::SessionManager::new()))
        .invoke_handler(tauri::generate_handler![
            audio::list_audio_devices,
            audio::start_recording,
            audio::stop_recording,
            system_audio::start_system_audio,
            system_audio::stop_system_audio,
            transcription::list_models,
            transcription::is_model_downloaded,
            transcription::download_model,
            transcription::start_transcription,
            transcription::stop_transcription,
            settings::get_settings,
            settings::update_settings,
            settings::get_default_output_directory,
            settings::select_output_directory,
            settings::check_microphone_permission,
            settings::check_screen_recording_permission,
            secret_store::set_openai_api_key,
            secret_store::clear_openai_api_key,
            secret_store::has_openai_api_key,
            secret_store::set_elevenlabs_api_key,
            secret_store::clear_elevenlabs_api_key,
            secret_store::has_elevenlabs_api_key,
            session_commands::start_session,
            session_commands::finalize_and_save_session,
            session_commands::discard_session,
            session_commands::list_session_summaries_cmd,
            show_main_window,
            set_live_caption_window_visible,
            set_ring_light_visible,
        ])
        .setup(|app| {
            setup_tray(app)?;
            setup_overlay_windows(app)?;
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
