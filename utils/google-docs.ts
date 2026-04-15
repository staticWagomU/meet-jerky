/**
 * Google Docs API v1 helpers using fetch().
 */

const DOCS_API_BASE = "https://docs.googleapis.com/v1/documents";

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
		throw new Error(`Docs API error (${res.status}): ${body}`);
	}
	return res;
}

/**
 * Create a new Google Doc with the given title.
 */
export async function createDocument(
	token: string,
	title: string,
): Promise<{ documentId: string; documentUrl: string }> {
	const res = await docsApiFetch(token, DOCS_API_BASE, {
		method: "POST",
		body: JSON.stringify({ title }),
	});
	const data = (await res.json()) as { documentId: string };
	return {
		documentId: data.documentId,
		documentUrl: `https://docs.google.com/document/d/${data.documentId}/edit`,
	};
}

/**
 * Write content to the document body at index 1 (start of body).
 */
export async function writeDocumentContent(
	token: string,
	documentId: string,
	content: string,
): Promise<void> {
	await docsApiFetch(token, `${DOCS_API_BASE}/${documentId}:batchUpdate`, {
		method: "POST",
		body: JSON.stringify({
			requests: [
				{
					insertText: {
						location: { index: 1 },
						text: content,
					},
				},
			],
		}),
	});
}
