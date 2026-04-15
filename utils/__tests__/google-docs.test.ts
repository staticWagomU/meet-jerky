import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDocument, writeDocumentContent } from "../google-docs";

describe("google-docs", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		mockFetch.mockReset();
		globalThis.fetch = mockFetch;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("createDocument", () => {
		it("正しいエンドポイントとヘッダーでリクエストする", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({ documentId: "doc-123" }),
				text: async () => "",
			});

			const result = await createDocument("test-token", "テスト会議");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://docs.googleapis.com/v1/documents",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "Bearer test-token",
						"Content-Type": "application/json",
					}),
					body: JSON.stringify({ title: "テスト会議" }),
				}),
			);
			expect(result.documentId).toBe("doc-123");
			expect(result.documentUrl).toBe(
				"https://docs.google.com/document/d/doc-123/edit",
			);
		});

		it("APIエラー時に適切なエラーをスローする", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 403,
				text: async () => "Forbidden",
			});

			await expect(createDocument("token", "title")).rejects.toThrow(
				"Docs API error (403): Forbidden",
			);
		});
	});

	describe("writeDocumentContent", () => {
		it("batchUpdateでテキストを挿入する", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({}),
				text: async () => "",
			});

			await writeDocumentContent("test-token", "doc-123", "Hello World");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://docs.googleapis.com/v1/documents/doc-123:batchUpdate",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						requests: [
							{
								insertText: {
									location: { index: 1 },
									text: "Hello World",
								},
							},
						],
					}),
				}),
			);
		});

		it("APIエラー時に適切なエラーをスローする", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal Server Error",
			});

			await expect(
				writeDocumentContent("token", "doc-123", "content"),
			).rejects.toThrow("Docs API error (500): Internal Server Error");
		});

		it("日本語コンテンツを正しく送信する", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({}),
				text: async () => "",
			});

			const content =
				"AI 要約\n━━━\n会議の要約です。\n\n元の文字起こし\n田中: テスト";
			await writeDocumentContent("test-token", "doc-123", content);

			const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(callBody.requests[0].insertText.text).toBe(content);
		});
	});
});
