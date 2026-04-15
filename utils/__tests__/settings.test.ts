import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_PROMPT } from "../ai-client";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	mergeSettings,
	SETTINGS_STORAGE_KEY,
	saveSettings,
} from "../settings";
import { DEFAULT_MINUTES_TEMPLATE } from "../template";

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
});

describe("DEFAULT_SETTINGS", () => {
	it("has correct default values", () => {
		expect(DEFAULT_SETTINGS.retention.mode).toBe("count");
		expect(DEFAULT_SETTINGS.retention.maxCount).toBe(10);
		expect(DEFAULT_SETTINGS.retention.maxDays).toBe(30);
		expect(DEFAULT_SETTINGS.google.authenticated).toBe(false);
		expect(DEFAULT_SETTINGS.template.minutesTemplate).toBe(
			DEFAULT_MINUTES_TEMPLATE,
		);
		expect(DEFAULT_SETTINGS.template.customPrompt).toBe(DEFAULT_CUSTOM_PROMPT);
	});
});

describe("mergeSettings", () => {
	it("returns defaults when merging empty object", () => {
		const result = mergeSettings({}, DEFAULT_SETTINGS);
		expect(result).toEqual(DEFAULT_SETTINGS);
	});

	it("overrides only retention.mode while keeping other fields as defaults", () => {
		const result = mergeSettings(
			{ retention: { mode: "days" } },
			DEFAULT_SETTINGS,
		);
		expect(result.retention.mode).toBe("days");
		expect(result.retention.maxCount).toBe(10);
		expect(result.retention.maxDays).toBe(30);
		expect(result.google).toEqual(DEFAULT_SETTINGS.google);
		expect(result.template).toEqual(DEFAULT_SETTINGS.template);
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
			retention: { mode: "count" as const, unknown: "value" },
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

	it("handles partial updates on nested objects correctly", () => {
		const result = mergeSettings(
			{
				google: { authenticated: true },
				template: { customPrompt: "カスタムプロンプト" },
			},
			DEFAULT_SETTINGS,
		);
		expect(result.google.authenticated).toBe(true);
		expect(result.template.customPrompt).toBe("カスタムプロンプト");
		expect(result.template.minutesTemplate).toBe(DEFAULT_MINUTES_TEMPLATE);
		expect(result.retention).toEqual(DEFAULT_SETTINGS.retention);
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
				retention: { mode: "days" },
			},
		});
		const result = await loadSettings();
		expect(result.retention.mode).toBe("days");
		expect(result.retention.maxCount).toBe(10);
		expect(result.retention.maxDays).toBe(30);
		expect(result.google).toEqual(DEFAULT_SETTINGS.google);
		expect(result.template).toEqual(DEFAULT_SETTINGS.template);
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

// --- ai設定 ---

describe("DEFAULT_SETTINGSのai設定", () => {
	it("DEFAULT_SETTINGSにai設定が含まれる", () => {
		expect(DEFAULT_SETTINGS.ai).toBeDefined();
		expect(DEFAULT_SETTINGS.ai.provider).toBe("anthropic");
		expect(DEFAULT_SETTINGS.ai.apiKey).toBe("");
	});

	it("DEFAULT_SETTINGSのcustomPromptがDEFAULT_CUSTOM_PROMPTと一致する", () => {
		expect(DEFAULT_SETTINGS.template.customPrompt).toBe(DEFAULT_CUSTOM_PROMPT);
	});
});

describe("mergeSettingsのai設定マージ", () => {
	it("ai.providerのみ変更した場合、apiKeyはデフォルト値が保持される", () => {
		const result = mergeSettings(
			{ ai: { provider: "openai" } },
			DEFAULT_SETTINGS,
		);
		expect(result.ai.provider).toBe("openai");
		expect(result.ai.apiKey).toBe("");
	});

	it("ai.apiKeyのみ変更した場合、providerはデフォルト値が保持される", () => {
		const result = mergeSettings(
			{ ai: { apiKey: "sk-test-key" } },
			DEFAULT_SETTINGS,
		);
		expect(result.ai.provider).toBe("anthropic");
		expect(result.ai.apiKey).toBe("sk-test-key");
	});

	it("ai設定全体を変更した場合、正しくマージされる", () => {
		const result = mergeSettings(
			{ ai: { provider: "gemini", apiKey: "gemini-key-123" } },
			DEFAULT_SETTINGS,
		);
		expect(result.ai.provider).toBe("gemini");
		expect(result.ai.apiKey).toBe("gemini-key-123");
	});
});
