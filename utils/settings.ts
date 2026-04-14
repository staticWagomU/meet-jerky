import { DEFAULT_MINUTES_TEMPLATE } from "./template";
import type { UserSettings } from "./types";

export const SETTINGS_STORAGE_KEY = "user-settings";

export const DEFAULT_SETTINGS: UserSettings = {
	retention: {
		mode: "count",
		maxCount: 10,
		maxDays: 30,
	},
	google: { authenticated: false },
	template: { minutesTemplate: DEFAULT_MINUTES_TEMPLATE, customPrompt: "" },
};

/** Recursive partial type for UserSettings. */
type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Deep merge a partial settings object with defaults.
 * Only known keys from the defaults are kept; unknown keys are ignored.
 */
export function mergeSettings(
	partial: DeepPartial<UserSettings>,
	defaults: UserSettings,
): UserSettings {
	const result = { ...defaults };

	for (const key of Object.keys(defaults) as (keyof UserSettings)[]) {
		const partialValue = partial[key];
		if (partialValue === undefined) continue;

		const defaultValue = defaults[key];

		if (
			typeof defaultValue === "object" &&
			defaultValue !== null &&
			typeof partialValue === "object" &&
			partialValue !== null
		) {
			const merged = { ...defaultValue };
			for (const subKey of Object.keys(defaultValue) as string[]) {
				const sub = (partialValue as Record<string, unknown>)[subKey];
				if (sub !== undefined) {
					(merged as Record<string, unknown>)[subKey] = sub;
				}
			}
			(result as Record<string, unknown>)[key] = merged;
		} else {
			(result as Record<string, unknown>)[key] = partialValue;
		}
	}

	return result;
}

/**
 * Load user settings from browser.storage.local, merging with defaults.
 */
export async function loadSettings(): Promise<UserSettings> {
	const result = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
	const stored = result[SETTINGS_STORAGE_KEY] as
		| DeepPartial<UserSettings>
		| undefined;

	if (!stored) {
		return { ...DEFAULT_SETTINGS };
	}

	return mergeSettings(stored, DEFAULT_SETTINGS);
}

/**
 * Save user settings to browser.storage.local.
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
	await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}
