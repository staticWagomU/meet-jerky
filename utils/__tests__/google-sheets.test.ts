import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addAndWriteAISummarySheet,
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

// --- addAndWriteAISummarySheet ---

describe("addAndWriteAISummarySheet", () => {
	it("AI要約シートを追加して内容を書き込む", async () => {
		// 1回目: batchUpdate (addSheet), 2回目: values update
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({}),
				text: async () => "",
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({}),
				text: async () => "",
			});

		await addAndWriteAISummarySheet(
			"test-token",
			"spreadsheet-id",
			"要約行1\n要約行2\n要約行3",
		);

		expect(mockFetch).toHaveBeenCalledTimes(2);

		// 1回目のリクエスト: batchUpdate (addSheet)
		const [url1, options1] = mockFetch.mock.calls[0];
		expect(url1).toContain("spreadsheet-id:batchUpdate");
		expect(options1.method).toBe("POST");
		const body1 = JSON.parse(options1.body);
		expect(body1.requests[0].addSheet.properties.title).toBe("AI要約");

		// 2回目のリクエスト: values update
		const [url2, options2] = mockFetch.mock.calls[1];
		expect(url2).toContain(encodeURIComponent("AI要約!A1"));
		expect(url2).toContain("spreadsheet-id");
		expect(url2).toContain("valueInputOption=RAW");
		expect(options2.method).toBe("PUT");

		const body2 = JSON.parse(options2.body);
		expect(body2.values).toEqual([["要約行1"], ["要約行2"], ["要約行3"]]);
	});

	it("batchUpdate APIエラー時にエラーをスローする", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "Internal Server Error",
		});

		await expect(
			addAndWriteAISummarySheet(
				"test-token",
				"spreadsheet-id",
				"要約テキスト",
			),
		).rejects.toThrowError("Sheets API error (500): Internal Server Error");
	});

	it("values update APIエラー時にエラーをスローする", async () => {
		// 1回目(batchUpdate)は成功、2回目(values update)は失敗
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({}),
				text: async () => "",
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 403,
				text: async () => "Forbidden",
			});

		await expect(
			addAndWriteAISummarySheet(
				"test-token",
				"spreadsheet-id",
				"要約テキスト",
			),
		).rejects.toThrowError("Sheets API error (403): Forbidden");
	});
});
