import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});

describe("DEFAULT_SETTINGS", () => {
	it("has correct default values", () => {
		expect(DEFAULT_SETTINGS.retention.mode).toBe("count");
		expect(DEFAULT_SETTINGS.retention.maxCount).toBe(10);
		expect(DEFAULT_SETTINGS.retention.maxDays).toBe(30);
		expect(DEFAULT_SETTINGS.google.authenticated).toBe(false);
		expect(DEFAULT_SETTINGS.template.minutesTemplate).toBe("");
		expect(DEFAULT_SETTINGS.template.customPrompt).toBe("");
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
		expect(result.template.minutesTemplate).toBe("");
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
