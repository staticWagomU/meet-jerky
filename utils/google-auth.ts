/**
 * OAuth 2.0 helpers using chrome.identity.launchWebAuthFlow for Google authentication.
 * Uses launchWebAuthFlow instead of getAuthToken to support all Chromium browsers
 * (Chrome, Edge, Brave, Vivaldi, etc.).
 */

// Minimal type declarations for the Chrome APIs used here.
// Full @types/chrome is intentionally not installed to keep dependencies light.
declare namespace chrome {
	namespace identity {
		function launchWebAuthFlow(
			details: { url: string; interactive: boolean },
			callback: (responseUrl?: string) => void,
		): void;
		function getRedirectURL(path?: string): string;
	}
	namespace runtime {
		const lastError: { message?: string } | undefined;
		function getManifest(): {
			oauth2?: { client_id: string; scopes: string[] };
			[key: string]: unknown;
		};
	}
	namespace storage {
		namespace local {
			function get(
				keys: string | string[],
				callback: (result: Record<string, unknown>) => void,
			): void;
			function set(
				items: Record<string, unknown>,
				callback?: () => void,
			): void;
			function remove(
				keys: string | string[],
				callback?: () => void,
			): void;
		}
	}
}

/** Storage key used to persist the OAuth token in chrome.storage.local. */
export const OAUTH_TOKEN_KEY = "google-oauth-token";

/**
 * Get an OAuth token interactively (shows login UI if needed).
 * Uses the implicit grant flow via launchWebAuthFlow.
 * Throws on failure.
 */
export async function authenticate(): Promise<string> {
	const manifest = chrome.runtime.getManifest();
	const clientId = manifest.oauth2?.client_id;
	const scopes = manifest.oauth2?.scopes;

	if (!clientId || !scopes) {
		throw new Error("manifest.jsonにoauth2の設定がありません");
	}

	const redirectUri = chrome.identity.getRedirectURL();
	const authUrl =
		"https://accounts.google.com/o/oauth2/auth" +
		`?client_id=${encodeURIComponent(clientId)}` +
		`&redirect_uri=${encodeURIComponent(redirectUri)}` +
		"&response_type=token" +
		`&scope=${encodeURIComponent(scopes.join(" "))}`;

	return new Promise<string>((resolve, reject) => {
		chrome.identity.launchWebAuthFlow(
			{ url: authUrl, interactive: true },
			(responseUrl) => {
				if (chrome.runtime.lastError || !responseUrl) {
					reject(
						new Error(
							chrome.runtime.lastError?.message ?? "認証に失敗しました",
						),
					);
					return;
				}

				const url = new URL(responseUrl);
				const hashParams = new URLSearchParams(url.hash.substring(1));
				const accessToken = hashParams.get("access_token");

				if (!accessToken) {
					reject(new Error("アクセストークンを取得できませんでした"));
					return;
				}

				chrome.storage.local.set(
					{ [OAUTH_TOKEN_KEY]: accessToken },
					() => {
						if (chrome.runtime.lastError) {
							reject(
								new Error(
									chrome.runtime.lastError?.message ??
										"トークンの保存に失敗しました",
								),
							);
							return;
						}
						resolve(accessToken);
					},
				);
			},
		);
	});
}

/**
 * Remove stored token and revoke it on Google's side.
 */
export async function revokeToken(token: string): Promise<void> {
	await fetch(
		`https://accounts.google.com/o/oauth2/revoke?token=${token}`,
	);

	return new Promise<void>((resolve, reject) => {
		chrome.storage.local.remove(OAUTH_TOKEN_KEY, () => {
			if (chrome.runtime.lastError) {
				reject(
					new Error(
						chrome.runtime.lastError?.message ??
							"トークンの削除に失敗しました",
					),
				);
				return;
			}
			resolve();
		});
	});
}

/**
 * Check if user has a stored token.
 * Returns the token if exists, null otherwise.
 */
export async function getAuthToken(): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		chrome.storage.local.get(OAUTH_TOKEN_KEY, (result) => {
			const token = result[OAUTH_TOKEN_KEY];
			if (typeof token === "string" && token) {
				resolve(token);
			} else {
				resolve(null);
			}
		});
	});
}
