mod audio;
mod datetime_fmt;
mod markdown;
mod session;
mod settings;
mod system_audio;
mod transcript;
mod transcription;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, PhysicalPosition, Position, Size, WindowEvent,
};

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
                        let window_width = window
                            .outer_size()
                            .map(|s| s.width as f64)
                            .unwrap_or(400.0);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(audio::AudioStateHandle::new())
        .manage(transcription::TranscriptionStateHandle::new())
        .manage(settings::SettingsStateHandle::new())
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
        ])
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
