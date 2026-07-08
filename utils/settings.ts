import { DEFAULT_CUSTOM_PROMPT, DEFAULT_MODEL } from "./ai-client";
import type { UserSettings } from "./types";

export const SETTINGS_STORAGE_KEY = "user-settings";

export const DEFAULT_SETTINGS: UserSettings = {
	retention: {
		mode: "days",
		maxCount: 10,
		maxDays: 10,
	},
	ai: {
		apiKey: "",
		model: DEFAULT_MODEL,
		customPrompt: DEFAULT_CUSTOM_PROMPT,
	},
};

/** Recursive partial type for UserSettings. */
type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Shape of settings persisted by older versions (multi-provider AI,
 *  Google integration, minutes template). Used only for migration. */
interface LegacyStoredSettings {
	ai?: { provider?: string; apiKey?: string; model?: string };
	template?: { customPrompt?: string };
}

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
 * Migrate settings persisted by older versions in place on the stored object:
 * - AI provider was multi-provider (openai/anthropic/gemini). Non-OpenAI
 *   API keys and model names are useless now, so reset them to defaults.
 * - The AI summary prompt lived under `template.customPrompt`.
 */
function migrateLegacySettings(
	stored: DeepPartial<UserSettings> & LegacyStoredSettings,
): DeepPartial<UserSettings> {
	const ai = { ...stored.ai };

	if (ai.provider !== undefined && ai.provider !== "openai") {
		delete ai.apiKey;
		delete ai.model;
	}

	if (ai.customPrompt === undefined && stored.template?.customPrompt) {
		ai.customPrompt = stored.template.customPrompt;
	}

	return { ...stored, ai };
}

/**
 * OpenAI API key baked into the bundle at build time via `.env`
 * (`WXT_OPENAI_API_KEY`). Used only as a fallback when the user has not
 * entered a key in the options page. Read lazily so tests can stub it.
 */
export function getEmbeddedApiKey(): string {
	return (import.meta.env.WXT_OPENAI_API_KEY as string | undefined) ?? "";
}

/** Fill in the embedded API key when the user hasn't set one. */
function withEmbeddedApiKeyFallback(settings: UserSettings): UserSettings {
	if (settings.ai.apiKey) return settings;
	const embedded = getEmbeddedApiKey();
	if (!embedded) return settings;
	return { ...settings, ai: { ...settings.ai, apiKey: embedded } };
}

/**
 * Load user settings from browser.storage.local, merging with defaults.
 */
export async function loadSettings(): Promise<UserSettings> {
	const result = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
	const stored = result[SETTINGS_STORAGE_KEY] as
		| (DeepPartial<UserSettings> & LegacyStoredSettings)
		| undefined;

	if (!stored) {
		return withEmbeddedApiKeyFallback({ ...DEFAULT_SETTINGS });
	}

	return withEmbeddedApiKeyFallback(
		mergeSettings(migrateLegacySettings(stored), DEFAULT_SETTINGS),
	);
}

/**
 * Save user settings to browser.storage.local.
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
	await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}
