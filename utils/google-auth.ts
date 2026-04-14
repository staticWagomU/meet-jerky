/**
 * OAuth 2.0 helpers using chrome.identity for Google authentication.
 * Uses chrome.* API directly since getAuthToken is Chrome-specific.
 */

// Minimal type declarations for the Chrome identity API used here.
// Full @types/chrome is intentionally not installed to keep dependencies light.
declare namespace chrome {
	namespace identity {
		function getAuthToken(
			details: { interactive: boolean },
			callback: (token?: string) => void,
		): void;
		function removeCachedAuthToken(
			details: { token: string },
			callback: () => void,
		): void;
	}
	namespace runtime {
		const lastError: { message?: string } | undefined;
	}
}

/**
 * Get an OAuth token interactively (shows login UI if needed).
 * Throws on failure.
 */
export async function authenticate(): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		chrome.identity.getAuthToken({ interactive: true }, (token) => {
			if (chrome.runtime.lastError || !token) {
				reject(
					new Error(chrome.runtime.lastError?.message ?? "認証に失敗しました"),
				);
				return;
			}
			resolve(token);
		});
	});
}

/**
 * Remove cached token and revoke it on Google's side.
 */
export async function revokeToken(token: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		chrome.identity.removeCachedAuthToken({ token }, async () => {
			try {
				await fetch(
					`https://accounts.google.com/o/oauth2/revoke?token=${token}`,
				);
				resolve();
			} catch (err) {
				reject(err);
			}
		});
	});
}

/**
 * Check if user has a cached token (non-interactive).
 * Returns the token if exists, null otherwise.
 */
export async function getAuthToken(): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		chrome.identity.getAuthToken({ interactive: false }, (token) => {
			if (chrome.runtime.lastError || !token) {
				resolve(null);
				return;
			}
			resolve(token);
		});
	});
}
