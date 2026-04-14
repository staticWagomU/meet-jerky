/**
 * Google Sheets API v4 helpers using fetch().
 */

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Helper for authorized fetch against the Sheets API.
 * Throws on non-OK responses with the error message from the API.
 */
async function sheetsApiFetch(
	url: string,
	token: string,
	options?: RequestInit,
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options?.headers,
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Sheets API error (${res.status}): ${body}`);
	}
	return res;
}

/**
 * Create a new spreadsheet with 2 tabs: "議事録" and "Raw Log".
 */
export async function createSpreadsheet(
	token: string,
	title: string,
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
	const res = await sheetsApiFetch(SHEETS_API, token, {
		method: "POST",
		body: JSON.stringify({
			properties: { title },
			sheets: [
				{ properties: { title: "議事録" } },
				{ properties: { title: "Raw Log" } },
			],
		}),
	});
	const data = (await res.json()) as {
		spreadsheetId: string;
		spreadsheetUrl: string;
	};
	return {
		spreadsheetId: data.spreadsheetId,
		spreadsheetUrl: data.spreadsheetUrl,
	};
}

/**
 * Write minutes content to the "議事録" sheet (Tab 1).
 * Splits the template output into rows by newline, writing each as a row in column A.
 */
export async function writeMinutesSheet(
	token: string,
	spreadsheetId: string,
	minutesContent: string,
): Promise<void> {
	const rows = minutesContent.split("\n").map((line) => [line]);
	const range = encodeURIComponent("議事録!A1");
	await sheetsApiFetch(
		`${SHEETS_API}/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
		token,
		{
			method: "PUT",
			body: JSON.stringify({ values: rows }),
		},
	);
}

/**
 * Write raw transcript to "Raw Log" sheet (Tab 2).
 * Header: ["タイムスタンプ", "発言者", "テキスト"]
 * Then each RawCaptionEntry as a row.
 */
export async function writeRawLogSheet(
	token: string,
	spreadsheetId: string,
	rawEntries: Array<{ timestamp: string; personName: string; text: string }>,
): Promise<void> {
	const header = ["タイムスタンプ", "発言者", "テキスト"];
	const rows = [
		header,
		...rawEntries.map((entry) => [
			entry.timestamp,
			entry.personName,
			entry.text,
		]),
	];
	const range = encodeURIComponent("Raw Log!A1");
	await sheetsApiFetch(
		`${SHEETS_API}/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
		token,
		{
			method: "PUT",
			body: JSON.stringify({ values: rows }),
		},
	);
}
