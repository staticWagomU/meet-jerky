import type {
	CaptionData,
	MeetingSession,
	RawCaptionEntry,
	TranscriptBlock,
} from "./types";

/** System messages to filter out */
const SYSTEM_MESSAGE_PATTERNS = [
	"you left the meeting",
	"あなたは退出しました",
	"you are presenting",
	"画面を共有しています",
	"recording has started",
	"録画が開始されました",
	"recording has stopped",
	"録画が停止されました",
	"is presenting",
	"が画面を共有",
	"joined the meeting",
	"が参加しました",
	"left the meeting",
	"が退出しました",
];

/**
 * Extract meeting code from a Google Meet URL pathname.
 * Expected format: /xxx-yyyy-zzz
 */
export function extractMeetingCodeFromPath(pathname: string): string {
	const match = pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
	return match ? match[1] : "";
}

/**
 * Check if a text string is a system message that should be filtered out.
 */
export function isSystemMessage(text: string): boolean {
	const lower = text.toLowerCase();
	return SYSTEM_MESSAGE_PATTERNS.some((pattern) =>
		lower.includes(pattern.toLowerCase()),
	);
}

/**
 * Format an ISO timestamp to Japanese locale date string.
 */
export function formatDate(isoString: string): string {
	const date = new Date(isoString);
	return date.toLocaleDateString("ja-JP", {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * Format an ISO timestamp to time-only string.
 */
export function formatTimeOnly(isoString: string): string {
	const date = new Date(isoString);
	return date.toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * Format transcript blocks as plain text for clipboard copy.
 */
export function formatTranscriptAsText(
	transcript: TranscriptBlock[],
	formatTimeFn: (iso: string) => string = formatTimeOnly,
): string {
	const diffed = computeTranscriptDiffs(transcript);
	const participants = extractParticipants(transcript);
	const header =
		participants.length > 0 ? `参加者: ${participants.join(", ")}\n\n` : "";
	const body = diffed
		.map((block) => {
			const time = formatTimeFn(block.timestamp);
			return `${block.personName} (${time})\n${block.transcriptText}`;
		})
		.join("\n\n");
	return header + body;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Format a meeting session as a JSON string for export.
 */
export function formatSessionAsJson(session: MeetingSession): string {
	return JSON.stringify(session, null, 2);
}

/**
 * Get the display title for a session: meetingTitle if available, otherwise meetingCode.
 */
export function getSessionDisplayTitle(session: {
	meetingTitle: string;
	meetingCode: string;
}): string {
	return session.meetingTitle || session.meetingCode;
}

/**
 * Build an export filename from a session's title/code and start date.
 * Example: "MyMeeting_2026-04-03.md", "abc-defg-hij_2026-04-03_raw.txt"
 */
export function buildExportFilename(
	session: { meetingTitle: string; meetingCode: string; startTimestamp: string },
	extension: string,
	suffix?: string,
): string {
	const base = getSessionDisplayTitle(session);
	const date = session.startTimestamp.split("T")[0];
	const suffixPart = suffix ? `_${suffix}` : "";
	return `${base}_${date}${suffixPart}.${extension}`;
}

/**
 * Format a meeting session as Markdown for export.
 */
export function formatSessionAsMarkdown(
	session: MeetingSession,
	formatTimeFn: (iso: string) => string = formatTimeOnly,
): string {
	const participants = extractParticipants(session.transcript);
	const diffed = computeTranscriptDiffs(session.transcript);

	const header =
		`# ${getSessionDisplayTitle(session)}\n\n` +
		`- **会議コード**: ${session.meetingCode}\n` +
		`- **開始**: ${formatDate(session.startTimestamp)}\n` +
		(session.endTimestamp
			? `- **終了**: ${formatDate(session.endTimestamp)}\n`
			: "") +
		`- **発言数**: ${session.transcript.length}\n` +
		(participants.length > 0
			? `- **参加者**: ${participants.join(", ")}\n`
			: "") +
		`\n---\n\n`;

	const body = diffed
		.map((block) => {
			const time = formatTimeFn(block.timestamp);
			return `**${block.personName}** (${time})\n\n${block.transcriptText}`;
		})
		.join("\n\n---\n\n");

	return header + body;
}

/**
 * Compute transcript diffs: for consecutive same-speaker entries,
 * strip the accumulated prefix so only the new portion is shown.
 */
export function computeTranscriptDiffs(
	transcript: TranscriptBlock[],
): TranscriptBlock[] {
	return transcript.map((block, index) => {
		if (index === 0) return block;
		const prev = transcript[index - 1];
		if (
			prev.personName === block.personName &&
			block.transcriptText.startsWith(prev.transcriptText)
		) {
			const diffText = block.transcriptText
				.substring(prev.transcriptText.length)
				.trim();
			if (diffText) {
				return { ...block, transcriptText: diffText };
			}
		}
		return block;
	});
}

/**
 * Extract unique participant names in order of first appearance.
 */
export function extractParticipants(transcript: TranscriptBlock[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const block of transcript) {
		if (!seen.has(block.personName)) {
			seen.add(block.personName);
			result.push(block.personName);
		}
	}
	return result;
}

/**
 * Format raw caption entries as plain text for export.
 * Each entry is a raw DOM observation with no deduplication or filtering.
 */
export function formatRawTranscriptAsText(
	rawTranscript: RawCaptionEntry[],
	formatTimeFn: (iso: string) => string = formatTimeOnly,
): string {
	return rawTranscript
		.map((entry) => {
			const time = formatTimeFn(entry.timestamp);
			return `[${time}] ${entry.personName}: ${entry.text}`;
		})
		.join("\n");
}

/** Threshold for text length decrease to detect a reset */
export const TEXT_RESET_THRESHOLD = 250;

/**
 * Determine the action to take when a caption mutation is observed.
 * Pure logic - no DOM or side effects.
 */
export function determineCaptionAction(
	currentBlock: CaptionData | null,
	newData: CaptionData,
):
	| { action: "start"; block: CaptionData }
	| {
			action: "commit_and_start";
			commitBlock: CaptionData;
			newBlock: CaptionData;
	  }
	| { action: "update"; block: CaptionData } {
	if (!currentBlock) {
		return {
			action: "start",
			block: { personName: newData.personName, text: newData.text },
		};
	}

	// Speaker changed
	if (newData.personName && newData.personName !== currentBlock.personName) {
		return {
			action: "commit_and_start",
			commitBlock: { ...currentBlock },
			newBlock: { personName: newData.personName, text: newData.text },
		};
	}

	// Text reset detection (250+ char decrease)
	if (currentBlock.text.length - newData.text.length >= TEXT_RESET_THRESHOLD) {
		return {
			action: "commit_and_start",
			commitBlock: { ...currentBlock },
			newBlock: {
				personName: newData.personName || currentBlock.personName,
				text: newData.text,
			},
		};
	}

	// Same speaker, text updated
	return {
		action: "update",
		block: {
			personName: newData.personName || currentBlock.personName,
			text: newData.text,
		},
	};
}
