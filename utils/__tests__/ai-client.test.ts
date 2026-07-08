import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	chatAboutTranscript,
	DEFAULT_CUSTOM_PROMPT,
	DEFAULT_MODEL,
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

// --- Mock response factories ---

function mockOpenAIResponse(content: string) {
	return {
		ok: true,
		json: async () => ({ choices: [{ message: { content } }] }),
		text: async () => "",
	};
}

function mockErrorResponse(status: number, text: string) {
	return {
		ok: false,
		status,
		text: async () => text,
	};
}

function mockEmptyJsonResponse(json: unknown) {
	return {
		ok: true,
		json: async () => json,
		text: async () => "",
	};
}

function lastRequestBody() {
	const [, options] = mockFetch.mock.calls[0];
	return JSON.parse(options.body);
}

// --- summarizeTranscript ---

describe("summarizeTranscript", () => {
	it("APIキー未設定時にエラーをスローする", async () => {
		await expect(
			summarizeTranscript("", "test", "test", "gpt-4o-mini"),
		).rejects.toThrowError("APIキーが設定されていません");
	});

	it("正しいエンドポイントとヘッダーでリクエストする", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("要約結果"));

		await summarizeTranscript(
			"sk-test-key",
			"カスタムプロンプト",
			"文字起こしテキスト",
			"gpt-4o-mini",
		);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0];

		expect(url).toBe("https://api.openai.com/v1/chat/completions");
		expect(options.method).toBe("POST");
		expect(options.headers["Content-Type"]).toBe("application/json");
		expect(options.headers.Authorization).toBe("Bearer sk-test-key");

		const body = lastRequestBody();
		expect(body.model).toBe("gpt-4o-mini");
		expect(body.messages).toEqual([
			{ role: "system", content: "カスタムプロンプト" },
			{ role: "user", content: "文字起こしテキスト" },
		]);
	});

	it("API成功時にレスポンステキストを返す", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("要約結果テキスト"));

		const result = await summarizeTranscript(
			"sk-test-key",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
		);

		expect(result).toBe("要約結果テキスト");
	});

	it("空のプロンプトでDEFAULT_CUSTOM_PROMPTにフォールバックする", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("要約結果"));

		await summarizeTranscript("sk-test", "", "テスト文字起こし", "gpt-4o-mini");

		const body = lastRequestBody();
		expect(body.messages[0].content).toBe(DEFAULT_CUSTOM_PROMPT);
	});

	it("空のモデル名でDEFAULT_MODELにフォールバックする", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("要約結果"));

		await summarizeTranscript("sk-test", "プロンプト", "文字起こし", "");

		const body = lastRequestBody();
		expect(body.model).toBe(DEFAULT_MODEL);
	});

	it("APIエラー時に適切なエラーメッセージをスローする", async () => {
		mockFetch.mockResolvedValue(mockErrorResponse(401, "Unauthorized"));

		await expect(
			summarizeTranscript(
				"sk-bad-key",
				"プロンプト",
				"文字起こし",
				"gpt-4o-mini",
			),
		).rejects.toThrowError("OpenAI API error (401): Unauthorized");
	});

	it("空のchoices配列で適切にエラーハンドリングする", async () => {
		mockFetch.mockResolvedValue(mockEmptyJsonResponse({ choices: [] }));

		await expect(
			summarizeTranscript("sk-test", "プロンプト", "文字起こし", "gpt-4o-mini"),
		).rejects.toThrowError("OpenAI: レスポンスが不正です");
	});

	it("ネットワークエラー時にエラーをスローする", async () => {
		mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(
			summarizeTranscript("sk-test", "プロンプト", "文字起こし", "gpt-4o-mini"),
		).rejects.toThrow();
	});
});

// --- メモパラメータ ---

describe("メモパラメータ", () => {
	it("メモが指定された場合、ユーザーメッセージにメモが含まれる", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("要約結果"));

		await summarizeTranscript(
			"sk-test",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
			"会議の感想メモ",
		);

		const body = lastRequestBody();
		const userContent = body.messages[1].content;
		expect(userContent).toContain("文字起こし");
		expect(userContent).toContain("会議の感想メモ");
	});

	it("メモが空文字の場合、トランスクリプトのみ送信される", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("要約結果"));

		await summarizeTranscript(
			"sk-test",
			"プロンプト",
			"文字起こし",
			"gpt-4o-mini",
			"",
		);

		const body = lastRequestBody();
		expect(body.messages[1].content).toBe("文字起こし");
	});
});

// --- chatAboutTranscript ---

describe("chatAboutTranscript", () => {
	it("APIキー未設定時にエラーをスローする", async () => {
		await expect(
			chatAboutTranscript("", "gpt-4o-mini", "文字起こし", [
				{ role: "user", content: "質問" },
			]),
		).rejects.toThrowError("APIキーが設定されていません");
	});

	it("システムプロンプトに文字起こしが含まれる", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("回答"));

		await chatAboutTranscript(
			"sk-test",
			"gpt-4o-mini",
			"田中: おはようございます",
			[{ role: "user", content: "誰が挨拶しましたか？" }],
		);

		const body = lastRequestBody();
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[0].content).toContain("田中: おはようございます");
	});

	it("会話履歴がそのまま送信される", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("2回目の回答"));

		const history = [
			{ role: "user" as const, content: "最初の質問" },
			{ role: "assistant" as const, content: "最初の回答" },
			{ role: "user" as const, content: "続きの質問" },
		];

		await chatAboutTranscript("sk-test", "gpt-4o-mini", "文字起こし", history);

		const body = lastRequestBody();
		// システムプロンプト + 履歴3件
		expect(body.messages).toHaveLength(4);
		expect(body.messages.slice(1)).toEqual(history);
	});

	it("API成功時に回答テキストを返す", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("AIの回答です"));

		const result = await chatAboutTranscript(
			"sk-test",
			"gpt-4o-mini",
			"文字起こし",
			[{ role: "user", content: "質問" }],
		);

		expect(result).toBe("AIの回答です");
	});

	it("空のモデル名でDEFAULT_MODELにフォールバックする", async () => {
		mockFetch.mockResolvedValue(mockOpenAIResponse("回答"));

		await chatAboutTranscript("sk-test", "", "文字起こし", [
			{ role: "user", content: "質問" },
		]);

		const body = lastRequestBody();
		expect(body.model).toBe(DEFAULT_MODEL);
	});

	it("APIエラー時に適切なエラーメッセージをスローする", async () => {
		mockFetch.mockResolvedValue(mockErrorResponse(429, "Rate limited"));

		await expect(
			chatAboutTranscript("sk-test", "gpt-4o-mini", "文字起こし", [
				{ role: "user", content: "質問" },
			]),
		).rejects.toThrowError("OpenAI API error (429): Rate limited");
	});
});
