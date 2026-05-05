//! `AppSettings` の取得 / 更新 / デフォルト出力先取得 / フォルダ選択ダイアログを
//! 提供する tauri コマンド群。`settings.rs` 本体の `AppSettings` 永続化責務 +
//! `TranscriptionEngineType` 定義とは独立しているため、機能境界で分離する。
//! `settings_permission.rs` (Loop 89) と並立する settings 軸 2 件目。

use crate::settings::{default_output_directory, AppSettings, SettingsStateHandle};

/// 現在の設定を返す
#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsStateHandle>) -> AppSettings {
    state.0.lock().clone()
}

/// 設定を更新して保存する
#[tauri::command]
pub fn update_settings(
    settings: AppSettings,
    state: tauri::State<'_, SettingsStateHandle>,
) -> Result<(), String> {
    settings.save()?;
    *state.0.lock() = settings;
    Ok(())
}

/// デフォルトの出力ディレクトリパスを返す
#[tauri::command]
pub fn get_default_output_directory() -> String {
    default_output_directory().to_string_lossy().to_string()
}

/// ネイティブフォルダ選択ダイアログを開く
#[tauri::command]
pub fn select_output_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}
