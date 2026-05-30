import { invoke } from "@tauri-apps/api/core";

export const SETTINGS_WINDOW_REQUEST_EVENT = "meet-jerky-open-settings-category";

export const SETTINGS_CATEGORY_KEYS = [
  "general",
  "detection",
  "audio",
  "transcription",
  "aiMinutes",
  "privacy",
] as const;

export type SettingsCategoryKey = (typeof SETTINGS_CATEGORY_KEYS)[number];

export function isSettingsCategoryKey(
  value: string | null | undefined,
): value is SettingsCategoryKey {
  return SETTINGS_CATEGORY_KEYS.includes(value as SettingsCategoryKey);
}

export async function showSettingsWindow(
  category?: SettingsCategoryKey,
): Promise<void> {
  await invoke("show_settings_window", { category });
}
