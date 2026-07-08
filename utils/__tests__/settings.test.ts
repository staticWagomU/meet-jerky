import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_PROMPT, DEFAULT_MODEL } from "../ai-client";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	mergeSettings,
	SETTINGS_STORAGE_KEY,
	saveSettings,
} from "../settings";

const mockGet = vi.fn();
const mockSet = vi.fn();

beforeEach(() => {
	vi.stubGlobal("browser", {
		storage: {
			local: {
				get: mockGet,
				set: mockSet,
			},
		},
	});
	mockGet.mockReset();
	mockSet.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("DEFAULT_SETTINGS", () => {
	it("has correct default values", () => {
		expect(DEFAULT_SETTINGS.retention.mode).toBe("days");
		expect(DEFAULT_SETTINGS.retention.maxCount).toBe(10);
		expect(DEFAULT_SETTINGS.retention.maxDays).toBe(10);
		expect(DEFAULT_SETTINGS.ai.apiKey).toBe("");
		expect(DEFAULT_SETTINGS.ai.model).toBe(DEFAULT_MODEL);
		expect(DEFAULT_SETTINGS.ai.customPrompt).toBe(DEFAULT_CUSTOM_PROMPT);
	});
});

describe("mergeSettings", () => {
	it("returns defaults when merging empty object", () => {
		const result = mergeSettings({}, DEFAULT_SETTINGS);
		expect(result).toEqual(DEFAULT_SETTINGS);
	});

	it("overrides only retention.mode while keeping other fields as defaults", () => {
		const result = mergeSettings(
			{ retention: { mode: "count" } },
			DEFAULT_SETTINGS,
		);
		expect(result.retention.mode).toBe("count");
		expect(result.retention.maxCount).toBe(10);
		expect(result.retention.maxDays).toBe(10);
		expect(result.ai).toEqual(DEFAULT_SETTINGS.ai);
	});

	it("merges full retention object correctly", () => {
		const result = mergeSettings(
			{ retention: { mode: "days", maxCount: 5, maxDays: 7 } },
			DEFAULT_SETTINGS,
		);
		expect(result.retention).toEqual({
			mode: "days",
			maxCount: 5,
			maxDays: 7,
		});
	});

	it("ignores unknown keys in nested objects", () => {
		const partial = {
			retention: { mode: "days" as const, unknown: "value" },
		};
		const result = mergeSettings(
			partial as Parameters<typeof mergeSettings>[0],
			DEFAULT_SETTINGS,
		);
		expect(result.retention).toEqual(DEFAULT_SETTINGS.retention);
		expect(
			(result.retention as Record<string, unknown>).unknown,
		).toBeUndefined();
	});

	it("ignores legacy top-level keys (google, template)", () => {
		const partial = {
			google: { authenticated: true },
			template: { minutesTemplate: "old", customPrompt: "old" },
		};
		const result = mergeSettings(
			partial as Parameters<typeof mergeSettings>[0],
			DEFAULT_SETTINGS,
		);
		expect(result).toEqual(DEFAULT_SETTINGS);
		expect(
			(result as unknown as Record<string, unknown>).google,
		).toBeUndefined();
		expect(
			(result as unknown as Record<string, unknown>).template,
		).toBeUndefined();
	});

	it("ai.apiKeyのみ変更した場合、他のai設定はデフォルト値が保持される", () => {
		const result = mergeSettings(
			{ ai: { apiKey: "sk-test-key" } },
			DEFAULT_SETTINGS,
		);
		expect(result.ai.apiKey).toBe("sk-test-key");
		expect(result.ai.model).toBe(DEFAULT_MODEL);
		expect(result.ai.customPrompt).toBe(DEFAULT_CUSTOM_PROMPT);
	});
});

describe("loadSettings", () => {
	it("returns default settings when storage is empty", async () => {
		mockGet.mockResolvedValue({});
		const result = await loadSettings();
		expect(result).toEqual(DEFAULT_SETTINGS);
		expect(mockGet).toHaveBeenCalledWith(SETTINGS_STORAGE_KEY);
	});

	it("merges stored partial settings with defaults", async () => {
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: {
				retention: { mode: "count" },
			},
		});
		const result = await loadSettings();
		expect(result.retention.mode).toBe("count");
		expect(result.retention.maxCount).toBe(10);
		expect(result.ai).toEqual(DEFAULT_SETTINGS.ai);
	});
});

describe("loadSettingsのレガシー設定移行", () => {
	it("旧provider=openaiの場合、apiKeyとmodelを引き継ぐ", async () => {
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: {
				ai: { provider: "openai", apiKey: "sk-legacy", model: "gpt-4o" },
			},
		});
		const result = await loadSettings();
		expect(result.ai.apiKey).toBe("sk-legacy");
		expect(result.ai.model).toBe("gpt-4o");
	});

	it("旧provider=anthropicの場合、apiKeyとmodelをデフォルトにリセットする", async () => {
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: {
				ai: {
					provider: "anthropic",
					apiKey: "sk-ant-legacy",
					model: "claude-sonnet-4-5-20250514",
				},
			},
		});
		const result = await loadSettings();
		expect(result.ai.apiKey).toBe("");
		expect(result.ai.model).toBe(DEFAULT_MODEL);
	});

	it("旧provider=geminiの場合、apiKeyとmodelをデフォルトにリセットする", async () => {
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: {
				ai: {
					provider: "gemini",
					apiKey: "gemini-key",
					model: "gemini-2.5-flash",
				},
			},
		});
		const result = await loadSettings();
		expect(result.ai.apiKey).toBe("");
		expect(result.ai.model).toBe(DEFAULT_MODEL);
	});

	it("旧template.customPromptをai.customPromptに引き継ぐ", async () => {
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: {
				template: { customPrompt: "ユーザー独自のプロンプト" },
			},
		});
		const result = await loadSettings();
		expect(result.ai.customPrompt).toBe("ユーザー独自のプロンプト");
	});

	it("新形式のai.customPromptが存在する場合、旧template.customPromptより優先する", async () => {
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: {
				ai: { customPrompt: "新形式プロンプト" },
				template: { customPrompt: "旧形式プロンプト" },
			},
		});
		const result = await loadSettings();
		expect(result.ai.customPrompt).toBe("新形式プロンプト");
	});
});

describe("loadSettingsのビルド時埋め込みAPIキー", () => {
	it("ユーザー設定のapiKeyが空のとき、埋め込みキーにフォールバックする", async () => {
		vi.stubEnv("WXT_OPENAI_API_KEY", "sk-embedded");
		mockGet.mockResolvedValue({});
		const result = await loadSettings();
		expect(result.ai.apiKey).toBe("sk-embedded");
	});

	it("ユーザーが設定したapiKeyは埋め込みキーより優先される", async () => {
		vi.stubEnv("WXT_OPENAI_API_KEY", "sk-embedded");
		mockGet.mockResolvedValue({
			[SETTINGS_STORAGE_KEY]: { ai: { apiKey: "sk-user" } },
		});
		const result = await loadSettings();
		expect(result.ai.apiKey).toBe("sk-user");
	});

	it("埋め込みキーが無い場合はapiKeyは空文字のまま", async () => {
		mockGet.mockResolvedValue({});
		const result = await loadSettings();
		expect(result.ai.apiKey).toBe("");
	});
});

describe("saveSettings", () => {
	it("calls browser.storage.local.set with correct arguments", async () => {
		mockSet.mockResolvedValue(undefined);
		const settings = {
			...DEFAULT_SETTINGS,
			retention: { mode: "days" as const, maxCount: 5, maxDays: 7 },
		};
		await saveSettings(settings);
		expect(mockSet).toHaveBeenCalledWith({
			[SETTINGS_STORAGE_KEY]: settings,
		});
	});
});
