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
					"https://test-extension-id.chromiumapp.org/#access_token=test-token&token_type=Bearer",
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
			{ "google-oauth-token": "test-token" },
			expect.any(Function),
		);
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
	it("storageにトークンが存在する場合にトークンを返す", async () => {
		chromeMock.storage.local.get.mockImplementation(
			(
				_keys: unknown,
				callback: (result: Record<string, unknown>) => void,
			) => {
				callback({ "google-oauth-token": "stored-token" });
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBe("stored-token");
	});

	it("storageにトークンがない場合にnullを返す", async () => {
		chromeMock.storage.local.get.mockImplementation(
			(
				_keys: unknown,
				callback: (result: Record<string, unknown>) => void,
			) => {
				callback({});
			},
		);

		const { getAuthToken } = await import("../google-auth");
		const token = await getAuthToken();
		expect(token).toBeNull();
	});
});

describe("revokeToken", () => {
	it("fetchでrevokeを呼びstorageからトークンを削除する", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response());
		vi.stubGlobal("fetch", mockFetch);

		chromeMock.storage.local.remove.mockImplementation(
			(_keys: unknown, callback?: () => void) => {
				callback?.();
			},
		);

		const { revokeToken } = await import("../google-auth");
		await revokeToken("test-token");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://accounts.google.com/o/oauth2/revoke?token=test-token",
		);
		expect(chromeMock.storage.local.remove).toHaveBeenCalledWith(
			"google-oauth-token",
			expect.any(Function),
		);
	});

	it("storage.local.remove時にlastErrorがセットされている場合にリジェクトする", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response());
		vi.stubGlobal("fetch", mockFetch);

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
});
