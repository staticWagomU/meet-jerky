import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSpreadsheet,
	writeMinutesSheet,
	writeRawLogSheet,
} from "../google-sheets";
import type { RawCaptionEntry } from "../types";

const mockFetch = vi.fn();

beforeEach(() => {
	mockFetch.mockReset();
	globalThis.fetch = mockFetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// --- createSpreadsheet ---

describe("createSpreadsheet", () => {
	it("正しいPOSTリクエストを送信し、spreadsheetIdとspreadsheetUrlを返す", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				spreadsheetId: "abc123",
				spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc123",
			}),
			text: async () => "",
		});

		const result = await createSpreadsheet("test-token", "会議メモ");

		expect(result).toEqual({
			spreadsheetId: "abc123",
			spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc123",
		});

		// Verify the fetch call
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];
		expect(url).toBe("https://sheets.googleapis.com/v4/spreadsheets");
		expect(options.method).toBe("POST");

		const body = JSON.parse(options.body);
		expect(body.properties.title).toBe("会議メモ");
		expect(body.sheets).toHaveLength(2);
		expect(body.sheets[0].properties.title).toBe("議事録");
		expect(body.sheets[1].properties.title).toBe("Raw Log");
	});

	it("APIエラー時（非OKレスポンス）に例外をスローする", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 403,
			text: async () => "Forbidden",
		});

		await expect(createSpreadsheet("bad-token", "テスト")).rejects.toThrowError(
			"Sheets API error (403): Forbidden",
		);
	});
});

// --- writeMinutesSheet ---

describe("writeMinutesSheet", () => {
	it("コンテンツを改行で分割し、列Aの各行に書き込む。シート名「議事録」がURLエンコードされる", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		await writeMinutesSheet("test-token", "spreadsheet-id", "行1\n行2\n行3");

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];

		// URL should contain encoded "議事録!A1"
		expect(url).toContain(encodeURIComponent("議事録!A1"));
		expect(url).toContain("spreadsheet-id");
		expect(url).toContain("valueInputOption=RAW");
		expect(options.method).toBe("PUT");

		const body = JSON.parse(options.body);
		expect(body.values).toEqual([["行1"], ["行2"], ["行3"]]);
	});

	it("空文字列の場合でもAPIコールを行い、空行1つの配列を送信する", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		await writeMinutesSheet("test-token", "spreadsheet-id", "");

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		// "".split("\n") produces [""], so we get one row with an empty string
		expect(body.values).toEqual([[""]]);
	});
});

// --- writeRawLogSheet ---

describe("writeRawLogSheet", () => {
	it("ヘッダー行とデータ行を正しく書き込む", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		const entries = [
			{ timestamp: "10:00:00", personName: "太郎", text: "こんにちは" },
			{ timestamp: "10:01:00", personName: "花子", text: "おはよう" },
		];

		await writeRawLogSheet("test-token", "spreadsheet-id", entries);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];

		expect(url).toContain(encodeURIComponent("Raw Log!A1"));
		expect(url).toContain("spreadsheet-id");
		expect(url).toContain("valueInputOption=RAW");
		expect(options.method).toBe("PUT");

		const body = JSON.parse(options.body);
		expect(body.values).toEqual([
			["タイムスタンプ", "発言者", "テキスト"],
			["10:00:00", "太郎", "こんにちは"],
			["10:01:00", "花子", "おはよう"],
		]);
	});

	it("空のエントリ配列の場合、ヘッダー行のみ書き込む", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		await writeRawLogSheet("test-token", "spreadsheet-id", []);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body.values).toEqual([["タイムスタンプ", "発言者", "テキスト"]]);
	});

	it("RawCaptionEntry型のtimestampがstring型であることを確認する（型整合性テスト）", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		// RawCaptionEntry.timestamp is string in types.ts
		// writeRawLogSheet also expects timestamp: string
		// This test verifies they are compatible by passing RawCaptionEntry[] directly
		const entries: RawCaptionEntry[] = [
			{ timestamp: "2026-01-01T10:00:00Z", personName: "太郎", text: "テスト" },
		];

		await writeRawLogSheet("test-token", "spreadsheet-id", entries);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body.values[1][0]).toBe("2026-01-01T10:00:00Z");
		expect(typeof body.values[1][0]).toBe("string");
	});
});

// --- Authorization header ---

describe("Authorizationヘッダー", () => {
	it("createSpreadsheetのリクエストにBearer tokenが含まれる", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				spreadsheetId: "id",
				spreadsheetUrl: "url",
			}),
			text: async () => "",
		});

		await createSpreadsheet("my-secret-token", "テスト");

		const [, options] = mockFetch.mock.calls[0];
		expect(options.headers.Authorization).toBe("Bearer my-secret-token");
	});

	it("writeMinutesSheetのリクエストにBearer tokenが含まれる", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		await writeMinutesSheet("my-secret-token", "id", "content");

		const [, options] = mockFetch.mock.calls[0];
		expect(options.headers.Authorization).toBe("Bearer my-secret-token");
	});

	it("writeRawLogSheetのリクエストにBearer tokenが含まれる", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({}),
			text: async () => "",
		});

		await writeRawLogSheet("my-secret-token", "id", []);

		const [, options] = mockFetch.mock.calls[0];
		expect(options.headers.Authorization).toBe("Bearer my-secret-token");
	});
});
