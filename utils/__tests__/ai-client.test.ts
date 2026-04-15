import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CUSTOM_PROMPT,
	DEFAULT_MODELS,
	summarizeTranscript,
} from "../ai-client";

const mockFetch = vi.fn();

beforeEach(() => {
	mockFetch.mockReset();
	globalThis.fetch = mockFetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// --- summarizeTranscript ---

describe("summarizeTranscript", () => {
	it("APIキー未設定時にエラーをスローする", async () => {
		await expect(
			summarizeTranscript("openai", "", "test", "test", "gpt-4o-mini"),
		).rejects.toThrowError("APIキーが設定されていません");
	});

	it("空のプロンプトでDEFAULT_CUSTOM_PROMPTにフォールバックする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果" } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"openai",
			"sk-test",
			"",
			"テスト文字起こし",
			"gpt-4o-mini",
		);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body.messages[0].content).toBe(DEFAULT_CUSTOM_PROMPT);
	});

	it("空のモデル名でDEFAULT_MODELSにフォールバックする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果" } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"openai",
			"sk-test",
			"プロンプト",
			"文字起こし",
			"",
		);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body.model).toBe(DEFAULT_MODELS.openai);
	});
});

// --- OpenAI provider ---

describe("OpenAI provider", () => {
	it("正しいエンドポイントとヘッダーでリクエストする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果" } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"openai",
			"sk-test-key",
			"カスタムプロンプト",
			"文字起こしテキスト",
			"gpt-4o-mini",
		);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];

		// エンドポイント検証
		expect(url).toBe("https://api.openai.com/v1/chat/completions");

		// HTTPメソッド検証
		expect(options.method).toBe("POST");

		// ヘッダー検証
		expect(options.headers["Content-Type"]).toBe("application/json");
		expect(options.headers.Authorization).toBe("Bearer sk-test-key");

		// ボディ検証
		const body = JSON.parse(options.body);
		expect(body.model).toBe("gpt-4o-mini");
		expect(body.messages).toEqual([
			{ role: "system", content: "カスタムプロンプト" },
			{ role: "user", content: "文字起こしテキスト" },
		]);
	});

	it("API成功時にレスポンステキストを返す", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果テキスト" } }],
			}),
			text: async () => "",
		});

		const result = await summarizeTranscript(
			"openai",
			"sk-test-key",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
		);

		expect(result).toBe("要約結果テキスト");
	});

	it("APIエラー時に適切なエラーメッセージをスローする", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => "Unauthorized",
		});

		await expect(
			summarizeTranscript(
				"openai",
				"sk-bad-key",
				"プロンプト",
				"文字起こし",
				"gpt-4o-mini",
			),
		).rejects.toThrowError("OpenAI API error (401): Unauthorized");
	});
});

// --- Anthropic provider ---

describe("Anthropic provider", () => {
	it("正しいエンドポイントとヘッダーでリクエストする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				content: [{ text: "要約結果" }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"anthropic",
			"sk-ant-test-key",
			"カスタムプロンプト",
			"文字起こしテキスト",
			"claude-sonnet-4-5-20250514",
		);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];

		// エンドポイント検証
		expect(url).toBe("https://api.anthropic.com/v1/messages");

		// HTTPメソッド検証
		expect(options.method).toBe("POST");

		// ヘッダー検証
		expect(options.headers["Content-Type"]).toBe("application/json");
		expect(options.headers["x-api-key"]).toBe("sk-ant-test-key");
		expect(options.headers["anthropic-version"]).toBe("2023-06-01");
		expect(options.headers["anthropic-dangerous-direct-browser-access"]).toBe(
			"true",
		);

		// ボディ検証
		const body = JSON.parse(options.body);
		expect(body.model).toBe("claude-sonnet-4-5-20250514");
		expect(body.max_tokens).toBe(4096);
		expect(body.system).toBe("カスタムプロンプト");
		expect(body.messages).toEqual([
			{ role: "user", content: "文字起こしテキスト" },
		]);
	});

	it("API成功時にレスポンステキストを返す", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				content: [{ text: "Anthropic要約結果" }],
			}),
			text: async () => "",
		});

		const result = await summarizeTranscript(
			"anthropic",
			"sk-ant-test",
			"プロンプト",
			"文字起こし",
			"claude-sonnet-4-5-20250514",
		);

		expect(result).toBe("Anthropic要約結果");
	});

	it("APIエラー時に適切なエラーメッセージをスローする", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 429,
			text: async () => "Rate limited",
		});

		await expect(
			summarizeTranscript(
				"anthropic",
				"sk-ant-bad",
				"プロンプト",
				"文字起こし",
				"claude-sonnet-4-5-20250514",
			),
		).rejects.toThrowError("Anthropic API error (429): Rate limited");
	});
});

// --- Gemini provider ---

describe("Gemini provider", () => {
	it("APIキーをURLパラメータに含めてリクエストする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				candidates: [{ content: { parts: [{ text: "要約結果" }] } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"gemini",
			"gemini-api-key-123",
			"カスタムプロンプト",
			"文字起こしテキスト",
			"gemini-2.5-flash",
		);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];

		// URLにAPIキーとモデル名が含まれることを検証
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-api-key-123",
		);

		// HTTPメソッド検証
		expect(options.method).toBe("POST");

		// ヘッダー検証
		expect(options.headers["Content-Type"]).toBe("application/json");

		// ボディ検証
		const body = JSON.parse(options.body);
		expect(body.systemInstruction).toEqual({
			parts: [{ text: "カスタムプロンプト" }],
		});
		expect(body.contents).toEqual([
			{ parts: [{ text: "文字起こしテキスト" }] },
		]);
	});

	it("API成功時にレスポンステキストを返す", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				candidates: [{ content: { parts: [{ text: "Gemini要約結果" }] } }],
			}),
			text: async () => "",
		});

		const result = await summarizeTranscript(
			"gemini",
			"gemini-key",
			"プロンプト",
			"文字起こし",
			"gemini-2.5-flash",
		);

		expect(result).toBe("Gemini要約結果");
	});

	it("APIエラー時に適切なエラーメッセージをスローする", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 403,
			text: async () => "Forbidden",
		});

		await expect(
			summarizeTranscript(
				"gemini",
				"gemini-bad-key",
				"プロンプト",
				"文字起こし",
				"gemini-2.5-flash",
			),
		).rejects.toThrowError("Gemini API error (403): Forbidden");
	});
});

// --- メモパラメータ ---

describe("メモパラメータ", () => {
	it("メモが指定された場合、ユーザーメッセージにメモが含まれる（OpenAI）", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果" } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"openai",
			"sk-test",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
			"会議の感想メモ",
		);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		const userContent = body.messages[1].content;
		expect(userContent).toContain("文字起こし");
		expect(userContent).toContain("会議の感想メモ");
	});

	it("メモが指定された場合、ユーザーメッセージにメモが含まれる（Anthropic）", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				content: [{ text: "要約結果" }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"anthropic",
			"sk-ant-test",
			"プロンプト",
			"文字起こし",
			"claude-sonnet-4-5-20250514",
			"自分のメモ",
		);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		const userContent = body.messages[0].content;
		expect(userContent).toContain("文字起こし");
		expect(userContent).toContain("自分のメモ");
	});

	it("メモが指定された場合、ユーザーメッセージにメモが含まれる（Gemini）", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				candidates: [{ content: { parts: [{ text: "要約結果" }] } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"gemini",
			"gemini-key",
			"プロンプト",
			"文字起こし",
			"gemini-2.5-flash",
			"Gemini用メモ",
		);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		const userContent = body.contents[0].parts[0].text;
		expect(userContent).toContain("文字起こし");
		expect(userContent).toContain("Gemini用メモ");
	});

	it("メモが空文字の場合、従来通りトランスクリプトのみ送信される", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果" } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"openai",
			"sk-test",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
			"",
		);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body.messages[1].content).toBe("文字起こし");
	});

	it("メモが未指定の場合、従来通りトランスクリプトのみ送信される", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "要約結果" } }],
			}),
			text: async () => "",
		});

		await summarizeTranscript(
			"openai",
			"sk-test",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
		);

		const [, options] = mockFetch.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body.messages[1].content).toBe("文字起こし");
	});
});

// --- エッジケース ---

describe("エッジケース", () => {
	it("ネットワークエラー時にエラーをスローする", async () => {
		mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(
			summarizeTranscript(
				"openai",
				"sk-test",
				"プロンプト",
				"文字起こし",
				"gpt-4o-mini",
			),
		).rejects.toThrow();
	});

	it("OpenAI: 空のchoices配列で適切にエラーハンドリングする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [] }),
			text: async () => "",
		});

		// 空のchoices配列はTypeErrorではなく、わかりやすいエラーメッセージをスローすべき
		await expect(
			summarizeTranscript(
				"openai",
				"sk-test",
				"プロンプト",
				"文字起こし",
				"gpt-4o-mini",
			),
		).rejects.toThrowError("OpenAI: レスポンスが不正です");
	});

	it("Anthropic: 空のcontent配列で適切にエラーハンドリングする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({ content: [] }),
			text: async () => "",
		});

		// 空のcontent配列はTypeErrorではなく、わかりやすいエラーメッセージをスローすべき
		await expect(
			summarizeTranscript(
				"anthropic",
				"sk-ant-test",
				"プロンプト",
				"文字起こし",
				"claude-sonnet-4-5-20250514",
			),
		).rejects.toThrowError("Anthropic: レスポンスが不正です");
	});

	it("Gemini: 空のcandidates配列で適切にエラーハンドリングする", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({ candidates: [] }),
			text: async () => "",
		});

		// 空のcandidates配列はTypeErrorではなく、わかりやすいエラーメッセージをスローすべき
		await expect(
			summarizeTranscript(
				"gemini",
				"gemini-key",
				"プロンプト",
				"文字起こし",
				"gemini-2.5-flash",
			),
		).rejects.toThrowError("Gemini: レスポンスが不正です");
	});
});
