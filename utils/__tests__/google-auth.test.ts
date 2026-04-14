import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuthToken = vi.fn();
const mockRemoveCachedAuthToken = vi.fn();
const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("chrome", {
		identity: {
			getAuthToken: mockGetAuthToken,
			removeCachedAuthToken: mockRemoveCachedAuthToken,
		},
		runtime: {
			lastError: undefined,
		},
	});
	vi.stubGlobal("fetch", mockFetch);
	mockGetAuthToken.mockReset();
	mockRemoveCachedAuthToken.mockReset();
	mockFetch.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("authenticate", () => {
	it("認証成功時にトークンを返す", async () => {
		mockGetAuthToken.mockImplementation(
			(_details: unknown, callback: (token?: string) => void) => {
				callback("mock-token-123");
			},
		);

		const { authenticate } = await import("../google-auth");
		const token = await authenticate();
		expect(token).toBe("mock-token-123");
		expect(mockGetAuthToken).toHaveBeenCalledWith(
			{ interactive: true },
			expect.any(Function),
		);
	});

	it("chrome.runtime.lastErrorがセットされている場合にエラーをスローする", async () => {
		(globalThis.chrome as Record<string, unknown>).runtime = {
			lastError: { message: "User cancelled" },
		};
		mockGetAuthToken.mockImplementation(
			(_details: unknown, callback: (token?: string) => void) => {
				callback(undefined);
			},
		);

		const { authenticate } = await import("../google-auth");
		await expect(authenticate()).rejects.toThrow("User cancelled");
	});

	it("コールバックがトークンなし(undefined)の場合にエラーをスローする", async () => {
		mockGetAuthToken.mockImplementation(
			(_details: unknown, callback: (token?: string) => void) => {
				callback(undefined);
			},
		);

		const { authenticate } = await import("../google-auth");
		await expect(authenticate()).rejects.toThrow("認証に失敗しました");
	});
});

describe("revokeToken", () => {
	it("chrome.identity.removeCachedAuthTokenにトークンを渡して呼び出す", async () => {
		mockRemoveCachedAuthToken.mockImplementation(
			(_details: unknown, callback: () => void) => {
				callback();
			},
		);
		mockFetch.mockResolvedValue(new Response());

		const { revokeToken } = await import("../google-auth");
		await revokeToken("test-token");
		expect(mockRemoveCachedAuthToken).toHaveBeenCalledWith(
			{ token: "test-token" },
			expect.any(Function),
		);
	});

	it("正しいURLでGoogleのrevoke endpointを呼び出す", async () => {
		mockRemoveCachedAuthToken.mockImplementation(
			(_details: unknown, callback: () => void) => {
				callback();
			},
		);
		mockFetch.mockResolvedValue(new Response());

		const { revokeToken } = await import("../google-auth");
		await revokeToken("test-token");
		expect(mockFetch).toHaveBeenCalledWith(
			"https://accounts.google.com/o/oauth2/revoke?token=test-token",
		);
	});

	it("fetchがネットワークエラーで失敗した場合にリジェクトする", async () => {
		mockRemoveCachedAuthToken.mockImplementation(
			(_details: unknown, callback: () => void) => {
				callback();
			},
		);
		mockFetch.mockRejectedValue(new TypeError("Network error"));

		const { revokeToken } = await import("../google-auth");
		await expect(revokeToken("test-token")).rejects.toThrow("Network error");
	});
});

describe("getAuthToken", () => {
	it("キャッシュされたトークンが存在する場合にトークンを返す", async () => {
		mockGetAuthToken.mockImplementation(
			(_details: unknown, callback: (token?: string) => void) => {
				callback("cached-token");
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBe("cached-token");
		expect(mockGetAuthToken).toHaveBeenCalledWith(
			{ interactive: false },
			expect.any(Function),
		);
	});

	it("chrome.runtime.lastErrorがセットされている場合にnullを返す", async () => {
		(globalThis.chrome as Record<string, unknown>).runtime = {
			lastError: { message: "No token" },
		};
		mockGetAuthToken.mockImplementation(
			(_details: unknown, callback: (token?: string) => void) => {
				callback(undefined);
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBeNull();
	});

	it("トークンが利用不可の場合にnullを返す", async () => {
		mockGetAuthToken.mockImplementation(
			(_details: unknown, callback: (token?: string) => void) => {
				callback(undefined);
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBeNull();
	});
});
