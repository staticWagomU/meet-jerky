import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chromeMock = {
	identity: {
		launchWebAuthFlow: vi.fn(),
		getRedirectURL: vi.fn(() => "https://test-extension-id.chromiumapp.org/"),
	},
	runtime: {
		lastError: undefined as { message?: string } | undefined,
		getManifest: vi.fn(() => ({
			oauth2: {
				client_id: "test-client-id.apps.googleusercontent.com",
				scopes: ["https://www.googleapis.com/auth/documents"],
			},
		})),
	},
	storage: {
		local: {
			get: vi.fn(),
			set: vi.fn(),
			remove: vi.fn(),
		},
	},
};

beforeAll(() => {
	globalThis.chrome = chromeMock as unknown as typeof chrome;
});

beforeEach(() => {
	chromeMock.runtime.lastError = undefined;
	vi.clearAllMocks();
	vi.resetModules();
	vi.stubGlobal("fetch", vi.fn());
});

describe("authenticate", () => {
	it("launchWebAuthFlowが成功した場合にトークンを返し、storageに保存する", async () => {
		chromeMock.identity.launchWebAuthFlow.mockImplementation(
			(_details: unknown, callback: (responseUrl?: string) => void) => {
				callback(
					"https://test-extension-id.chromiumapp.org/#access_token=test-token&token_type=Bearer&expires_in=3600",
				);
			},
		);
		chromeMock.storage.local.set.mockImplementation(
			(_items: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { authenticate } = await import("../google-auth");
		const token = await authenticate();

		expect(token).toBe("test-token");
		expect(chromeMock.storage.local.set).toHaveBeenCalledWith(
			expect.objectContaining({
				"google-oauth-token": "test-token",
			}),
			expect.any(Function),
		);
	});

	it("expires_inを解析してexpiresAtをstorageに保存する", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);

		chromeMock.identity.launchWebAuthFlow.mockImplementation(
			(_details: unknown, callback: (responseUrl?: string) => void) => {
				callback(
					"https://test-extension-id.chromiumapp.org/#access_token=test-token&token_type=Bearer&expires_in=3600",
				);
			},
		);
		chromeMock.storage.local.set.mockImplementation(
			(_items: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { authenticate, OAUTH_EXPIRES_AT_KEY } = await import(
			"../google-auth"
		);
		await authenticate();

		expect(chromeMock.storage.local.set).toHaveBeenCalledWith(
			expect.objectContaining({
				[OAUTH_EXPIRES_AT_KEY]: now + 3600 * 1000,
			}),
			expect.any(Function),
		);

		vi.spyOn(Date, "now").mockRestore();
	});

	it("chrome.runtime.lastErrorがセットされている場合にlastErrorメッセージでリジェクトする", async () => {
		chromeMock.identity.launchWebAuthFlow.mockImplementation(
			(_details: unknown, callback: (responseUrl?: string) => void) => {
				chromeMock.runtime.lastError = { message: "User cancelled" };
				callback(undefined);
			},
		);

		const { authenticate } = await import("../google-auth");
		await expect(authenticate()).rejects.toThrow("User cancelled");
	});

	it("レスポンスURLがundefinedの場合に「認証に失敗しました」でリジェクトする", async () => {
		chromeMock.identity.launchWebAuthFlow.mockImplementation(
			(_details: unknown, callback: (responseUrl?: string) => void) => {
				callback(undefined);
			},
		);

		const { authenticate } = await import("../google-auth");
		await expect(authenticate()).rejects.toThrow("認証に失敗しました");
	});

	it("レスポンスURLにaccess_tokenがない場合に「アクセストークンを取得できませんでした」でリジェクトする", async () => {
		chromeMock.identity.launchWebAuthFlow.mockImplementation(
			(_details: unknown, callback: (responseUrl?: string) => void) => {
				callback(
					"https://test-extension-id.chromiumapp.org/#token_type=Bearer",
				);
			},
		);

		const { authenticate } = await import("../google-auth");
		await expect(authenticate()).rejects.toThrow(
			"アクセストークンを取得できませんでした",
		);
	});

	it("manifest.jsonにoauth2の設定がない場合にエラーをスローする", async () => {
		chromeMock.runtime.getManifest.mockReturnValueOnce({});

		const { authenticate } = await import("../google-auth");
		await expect(authenticate()).rejects.toThrow(
			"manifest.jsonにoauth2の設定がありません",
		);
	});
});

describe("getAuthToken", () => {
	it("storageにトークンが存在し有効期限内の場合にトークンを返す", async () => {
		const futureTime = Date.now() + 600_000; // 10 minutes from now
		chromeMock.storage.local.get.mockImplementation(
			(_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
				callback({
					"google-oauth-token": "stored-token",
					"google-oauth-token-expires-at": futureTime,
				});
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBe("stored-token");
	});

	it("storageにトークンがない場合にnullを返す", async () => {
		chromeMock.storage.local.get.mockImplementation(
			(_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
				callback({});
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBeNull();
	});

	it("トークンの有効期限が切れている場合にnullを返す", async () => {
		const pastTime = Date.now() - 1000; // 1 second ago
		chromeMock.storage.local.get.mockImplementation(
			(_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
				callback({
					"google-oauth-token": "expired-token",
					"google-oauth-token-expires-at": pastTime,
				});
			},
		);
		chromeMock.storage.local.remove.mockImplementation(
			(_keys: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBeNull();
	});

	it("有効期限が5分以内の場合にnullを返す（バッファ）", async () => {
		const almostExpired = Date.now() + 4 * 60 * 1000; // 4 minutes from now (< 5 min buffer)
		chromeMock.storage.local.get.mockImplementation(
			(_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
				callback({
					"google-oauth-token": "almost-expired-token",
					"google-oauth-token-expires-at": almostExpired,
				});
			},
		);
		chromeMock.storage.local.remove.mockImplementation(
			(_keys: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBeNull();
	});

	it("expiresAtがない場合（後方互換性）トークンをそのまま返す", async () => {
		chromeMock.storage.local.get.mockImplementation(
			(_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
				callback({ "google-oauth-token": "legacy-token" });
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBe("legacy-token");
	});
});

describe("revokeToken", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn().mockResolvedValue(new Response());
		vi.stubGlobal("fetch", mockFetch);
	});

	it("fetchでrevokeを呼びstorageからトークンとexpiresAtを削除する", async () => {
		chromeMock.storage.local.remove.mockImplementation(
			(_keys: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { revokeToken, OAUTH_TOKEN_KEY, OAUTH_EXPIRES_AT_KEY } =
			await import("../google-auth");
		await revokeToken("test-token");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://accounts.google.com/o/oauth2/revoke?token=test-token",
		);
		expect(chromeMock.storage.local.remove).toHaveBeenCalledWith(
			[OAUTH_TOKEN_KEY, OAUTH_EXPIRES_AT_KEY],
			expect.any(Function),
		);
	});

	it("storage.local.remove時にlastErrorがセットされている場合にリジェクトする", async () => {
		chromeMock.storage.local.remove.mockImplementation(
			(_keys: unknown, callback?: () => void) => {
				chromeMock.runtime.lastError = {
					message: "Failed to remove token",
				};
				callback?.();
			},
		);

		const { revokeToken } = await import("../google-auth");
		await expect(revokeToken("test-token")).rejects.toThrow(
			"Failed to remove token",
		);
	});

	it("expiresAtも一緒に削除する", async () => {
		chromeMock.storage.local.remove.mockImplementation(
			(_keys: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { revokeToken, OAUTH_EXPIRES_AT_KEY } = await import(
			"../google-auth"
		);
		await revokeToken("test-token");

		const removedKeys = chromeMock.storage.local.remove.mock.calls[0][0];
		expect(removedKeys).toContain(OAUTH_EXPIRES_AT_KEY);
	});
});
