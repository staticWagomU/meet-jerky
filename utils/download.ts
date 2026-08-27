import {
	computeTranscriptDiffs,
	extractParticipants,
	formatDate,
	formatSessionCopyText,
	formatTimeOnly,
} from "./helpers";
import type {
	AutoDownloadSettings,
	DownloadFormat,
	MeetingSession,
	TranscriptBlock,
} from "./types";

export const DEFAULT_DOWNLOAD_SUBFOLDER = "meet-jerky";

/** Fallback base name when neither a meeting title nor a code is available. */
const FALLBACK_FILE_BASE = "meeting";

/** Upper bound for the title part of a file name, in characters.
 *  Keeps the full path well below the OS limit once the folder,
 *  timestamp and extension are added. */
const MAX_FILE_NAME_PART = 80;

const EXTENSIONS: Record<DownloadFormat, string> = {
	txt: "txt",
	md: "md",
	json: "json",
};

const MIME_TYPES: Record<DownloadFormat, string> = {
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
};

/** A ready-to-pass argument pair for browser.downloads.download. */
export interface SessionDownload {
	/** Path relative to the browser download folder. */
	filename: string;
	/** data: URL holding the encoded transcript. */
	url: string;
}

// ─── Path building ───────────────────────────────────────────────────────────

/**
 * Make a single path segment safe as a file name: drop characters that are
 * illegal on Windows/macOS, collapse whitespace, and cap the length.
 * Returns an empty string when nothing usable remains.
 */
export function sanitizeFileNamePart(text: string): string {
	const cleaned = text
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are illegal in file names
		.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		// 先頭・末尾のドットは隠しファイル化や拡張子の誤認を招くため落とす
		.replace(/^[\s.]+|[\s.]+$/g, "")
		.slice(0, MAX_FILE_NAME_PART)
		.trim();

	// 置換後にアンダースコアしか残らない名前は情報を持たないため、
	// 呼び出し側がフォールバックできるよう空文字を返す
	return /^_*$/.test(cleaned) ? "" : cleaned;
}

/**
 * Normalize a user-supplied download subfolder into a relative path.
 * The downloads API refuses absolute paths and `..` segments, so both are
 * reduced to plain segments rather than rejected outright.
 */
export function sanitizeSubfolder(raw: string): string {
	return raw
		.replace(/\\/g, "/")
		.split("/")
		.map((segment) => sanitizeFileNamePart(segment))
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.join("/");
}

/**
 * Local-time stamp used to sort files chronologically: `YYYYMMDD-HHmm`.
 * Local time (not UTC) so the name matches the user's sense of when the
 * meeting happened.
 */
function fileNameTimestamp(isoString: string): string {
	const date = new Date(isoString);
	if (Number.isNaN(date.getTime())) return "00000000-0000";

	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}`
	);
}

/**
 * Build the download path (subfolder + file name) for a session.
 */
export function buildDownloadPath(
	session: MeetingSession,
	settings: AutoDownloadSettings,
): string {
	const base =
		sanitizeFileNamePart(session.meetingTitle) ||
		sanitizeFileNamePart(session.meetingCode) ||
		FALLBACK_FILE_BASE;

	const fileName = `${fileNameTimestamp(session.startTimestamp)}_${base}.${EXTENSIONS[settings.format]}`;

	const folder = sanitizeSubfolder(settings.subfolder);
	return folder ? `${folder}/${fileName}` : fileName;
}

// ─── Content building ────────────────────────────────────────────────────────

/**
 * The transcript to export: deduplicated blocks, falling back to the raw
 * caption log when no block was ever committed (mirrors the copy action).
 */
function resolveTranscriptBlocks(session: MeetingSession): TranscriptBlock[] {
	if (session.transcript.length > 0) {
		return computeTranscriptDiffs(session.transcript);
	}
	return session.rawTranscript.map((entry) => ({
		personName: entry.personName,
		timestamp: entry.timestamp,
		transcriptText: entry.text,
	}));
}

function formatSessionAsMarkdown(session: MeetingSession): string {
	const blocks = resolveTranscriptBlocks(session);
	const participants = extractParticipants(blocks);
	const title =
		session.meetingTitle || session.meetingCode || FALLBACK_FILE_BASE;

	const lines: string[] = [`# ${title}`, ""];

	if (session.meetingCode) lines.push(`- 会議コード: ${session.meetingCode}`);
	lines.push(`- 開始: ${formatDate(session.startTimestamp)}`);
	if (session.endTimestamp) {
		lines.push(`- 終了: ${formatDate(session.endTimestamp)}`);
	}
	if (participants.length > 0) {
		lines.push(`- 参加者: ${participants.join(", ")}`);
	}

	if (session.aiSummary) {
		lines.push("", "## AI要約", "", session.aiSummary.text);
	}

	lines.push("", "## 文字起こし", "");
	for (const block of blocks) {
		lines.push(
			`**${block.personName}** (${formatTimeOnly(block.timestamp)})`,
			"",
			block.transcriptText,
			"",
		);
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function formatSessionAsJson(session: MeetingSession): string {
	const blocks = resolveTranscriptBlocks(session);
	return `${JSON.stringify(
		{
			sessionId: session.sessionId,
			meetingCode: session.meetingCode,
			meetingTitle: session.meetingTitle,
			startTimestamp: session.startTimestamp,
			endTimestamp: session.endTimestamp,
			participants: extractParticipants(blocks),
			aiSummary: session.aiSummary,
			transcript: blocks,
		},
		null,
		2,
	)}\n`;
}

/**
 * Render a session in the requested export format.
 */
export function formatSessionForDownload(
	session: MeetingSession,
	format: DownloadFormat,
): string {
	switch (format) {
		case "md":
			return formatSessionAsMarkdown(session);
		case "json":
			return formatSessionAsJson(session);
		default:
			return formatSessionCopyText(session.transcript, session.rawTranscript);
	}
}

// ─── data: URL encoding ──────────────────────────────────────────────────────

/** btoa only accepts latin1, so encode to UTF-8 bytes first.
 *  Chunked to stay clear of the argument-count limit on long transcripts. */
const BASE64_CHUNK_SIZE = 0x8000;

function base64EncodeUtf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
	}
	return btoa(binary);
}

/**
 * Build a data: URL for the downloads API.
 * MV3 service workers cannot call URL.createObjectURL, so the file content
 * has to travel inline in the URL.
 */
export function toDataUrl(content: string, mimeType: string): string {
	return `data:${mimeType};charset=utf-8;base64,${base64EncodeUtf8(content)}`;
}

// ─── Decision + assembly ─────────────────────────────────────────────────────

/**
 * Whether a session should be auto-downloaded on meeting end.
 * Empty sessions are skipped (retention deletes them anyway), and a session
 * is only ever downloaded once.
 */
export function shouldAutoDownload(
	session: MeetingSession,
	settings: AutoDownloadSettings,
): boolean {
	if (!settings.enabled) return false;
	if (session.autoDownloadedAt) return false;
	return session.transcript.length > 0 || session.rawTranscript.length > 0;
}

/**
 * Build the download arguments for a session, or null when it should not
 * be downloaded.
 */
export function buildSessionDownload(
	session: MeetingSession,
	settings: AutoDownloadSettings,
): SessionDownload | null {
	if (!shouldAutoDownload(session, settings)) return null;

	const content = formatSessionForDownload(session, settings.format);
	if (!content.trim()) return null;

	return {
		filename: buildDownloadPath(session, settings),
		url: toDataUrl(content, MIME_TYPES[settings.format]),
	};
}
