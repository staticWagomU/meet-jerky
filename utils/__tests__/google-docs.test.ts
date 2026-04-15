import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDocument,
	DocsApiError,
	writeDocumentContent,
} from "../google-docs";

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

		it("APIエラー時にDocsApiErrorをスローしstatusプロパティを持つ", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 403,
				text: async () => "Forbidden",
			});

			try {
				await createDocument("token", "title");
				expect.fail("Should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(DocsApiError);
				expect((err as DocsApiError).status).toBe(403);
				expect((err as DocsApiError).message).toBe(
					"Docs API error (403): Forbidden",
				);
			}
		});

		it("401エラー時にDocsApiErrorのstatusが401になる", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 401,
				text: async () => "Unauthorized",
			});

			try {
				await createDocument("expired-token", "title");
				expect.fail("Should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(DocsApiError);
				expect((err as DocsApiError).status).toBe(401);
			}
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

		it("APIエラー時にDocsApiErrorをスローする", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal Server Error",
			});

			try {
				await writeDocumentContent("token", "doc-123", "content");
				expect.fail("Should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(DocsApiError);
				expect((err as DocsApiError).status).toBe(500);
			}
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
