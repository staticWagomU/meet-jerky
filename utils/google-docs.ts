/**
 * Google Docs API v1 helpers using fetch().
 */

const DOCS_API_BASE = "https://docs.googleapis.com/v1/documents";

/**
 * Custom error class for Docs API errors, exposing the HTTP status code.
 */
export class DocsApiError extends Error {
	readonly status: number;

	constructor(status: number, body: string) {
		super(`Docs API error (${status}): ${body}`);
		this.name = "DocsApiError";
		this.status = status;
	}
}

/**
 * Helper for authorized fetch against the Docs API.
 * Throws on non-OK responses with the error message from the API.
 */
async function docsApiFetch(
	token: string,
	url: string,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new DocsApiError(res.status, body);
	}
	return res;
}

/**
 * Response type for batchUpdate replies relevant to tab operations.
 */
interface BatchUpdateReply {
	addDocumentTab?: {
		tabProperties?: {
			tabId?: string;
			title?: string;
		};
	};
}

/**
 * Execute a batch update on a Google Doc with multiple requests.
 * Returns the replies array, which contains one reply per request.
 */
export async function batchUpdateDocument(
	token: string,
	documentId: string,
	requests: Record<string, unknown>[],
): Promise<{ replies: BatchUpdateReply[] }> {
	const res = await docsApiFetch(
		token,
		`${DOCS_API_BASE}/${documentId}:batchUpdate`,
		{
			method: "POST",
			body: JSON.stringify({ requests }),
		},
	);
	return res.json() as Promise<{ replies: BatchUpdateReply[] }>;
}

/**
 * Create a new Google Doc with the given title.
 * Also returns the default tab ID from the creation response.
 */
export async function createDocument(
	token: string,
	title: string,
): Promise<{ documentId: string; documentUrl: string; defaultTabId: string }> {
	const res = await docsApiFetch(token, DOCS_API_BASE, {
		method: "POST",
		body: JSON.stringify({ title }),
	});
	const data = (await res.json()) as {
		documentId: string;
		tabs?: Array<{ tabProperties?: { tabId?: string } }>;
	};
	return {
		documentId: data.documentId,
		documentUrl: `https://docs.google.com/document/d/${data.documentId}/edit`,
		defaultTabId: data.tabs?.[0]?.tabProperties?.tabId ?? "",
	};
}

/**
 * Write content to the document body at index 1 (start of body).
 * Optionally targets a specific tab by tabId.
 */
export async function writeDocumentContent(
	token: string,
	documentId: string,
	content: string,
	tabId?: string,
): Promise<void> {
	const location: Record<string, unknown> = { index: 1 };
	if (tabId) {
		location.tabId = tabId;
	}
	await docsApiFetch(token, `${DOCS_API_BASE}/${documentId}:batchUpdate`, {
		method: "POST",
		body: JSON.stringify({
			requests: [
				{
					insertText: {
						location,
						text: content,
					},
				},
			],
		}),
	});
}
