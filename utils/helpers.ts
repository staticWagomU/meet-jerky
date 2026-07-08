import type { CaptionData, RawCaptionEntry, TranscriptBlock } from "./types";

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
 * Get the display title for a session: meetingTitle if available, otherwise meetingCode.
 */
export function getSessionDisplayTitle(session: {
	meetingTitle: string;
	meetingCode: string;
}): string {
	return session.meetingTitle || session.meetingCode;
}

/** Ratio of LCP length to shorter text length above which the shorter entry
 *  is considered an intermediate snapshot absorbed by the longer one. */
const LCP_ABSORPTION_RATIO = 0.8;

/**
 * Compute the length of the longest common prefix between two strings.
 */
function longestCommonPrefixLength(a: string, b: string): number {
	const min = Math.min(a.length, b.length);
	let i = 0;
	while (i < min && a[i] === b[i]) i++;
	return i;
}

/**
 * Strip trailing sentence-ending punctuation for fuzzy substring comparison.
 * Speech recognition often adds/removes trailing punctuation between
 * intermediate snapshots (e.g. "ノートブック。" → "ノートブックめっちゃ").
 */
function stripTrailingPunctuation(text: string): string {
	return text.replace(/[。、！？!?,.\s]+$/g, "");
}

/** How many later same-speaker entries to inspect for absorption.
 *  Multiple simultaneous caption blocks interleave speakers in commit order,
 *  so absorption must look past other speakers' entries. */
const ABSORPTION_LOOKAHEAD = 6;

/**
 * Remove entries whose text is absorbed by a later same-speaker entry
 * (exact duplicate, substring, or LCP ≥ 80%). Looks ahead up to
 * ABSORPTION_LOOKAHEAD same-speaker entries, skipping other speakers'
 * interjections in between.
 */
function removeAbsorbedEntries(
	transcript: TranscriptBlock[],
): TranscriptBlock[] {
	const dominated = new Set<number>();

	for (let i = 0; i < transcript.length; i++) {
		if (dominated.has(i)) continue;
		const { personName } = transcript[i];
		const textI = transcript[i].transcriptText;
		const normI = stripTrailingPunctuation(textI);
		let candidates = 0;

		for (
			let j = i + 1;
			j < transcript.length && candidates < ABSORPTION_LOOKAHEAD;
			j++
		) {
			if (transcript[j].personName !== personName) continue;
			candidates++;
			const textJ = transcript[j].transcriptText;

			// Exact duplicate or substring match (also try with stripped punctuation)
			if (textJ.includes(textI) || (normI && textJ.includes(normI))) {
				dominated.add(i);
				break;
			}

			// LCP-based absorption: the shorter entry shares ≥80% prefix with
			// a longer (or equal-length) later entry → intermediate snapshot
			if (textJ.length >= textI.length) {
				const lcp = longestCommonPrefixLength(textI, textJ);
				if (lcp >= textI.length * LCP_ABSORPTION_RATIO) {
					dominated.add(i);
					break;
				}
			}
		}
	}

	return transcript.filter((_, idx) => !dominated.has(idx));
}

/** Minimum characters for a suffix/prefix overlap to be treated as the same
 *  utterance rather than a coincidental repetition. */
const MIN_SUFFIX_OVERLAP_CHARS = 8;

/**
 * Length of the longest suffix of `prev` that is also a prefix of `next`,
 * or 0 when the overlap is shorter than MIN_SUFFIX_OVERLAP_CHARS.
 * Detects Google Meet's sliding caption window, where the tail of the
 * previous snapshot reappears at the head of the next one.
 */
function longestSuffixPrefixOverlap(prev: string, next: string): number {
	const max = Math.min(prev.length, next.length);
	for (let len = max; len >= MIN_SUFFIX_OVERLAP_CHARS; len--) {
		if (next.startsWith(prev.slice(prev.length - len))) return len;
	}
	return 0;
}

/**
 * Compute transcript diffs: first remove entries absorbed by later
 * same-speaker entries, then strip accumulated prefixes and suffix
 * overlaps from the remainder.
 */
export function computeTranscriptDiffs(
	transcript: TranscriptBlock[],
): TranscriptBlock[] {
	if (transcript.length === 0) return [];

	// Pass 1: Remove absorbed entries within same-speaker groups
	const filtered = removeAbsorbedEntries(transcript);

	// Pass 2: Strip prefix diffs and suffix overlaps from consecutive
	// same-speaker entries
	return filtered.map((block, index) => {
		if (index === 0) return block;
		const prev = filtered[index - 1];
		if (prev.personName !== block.personName) return block;

		if (block.transcriptText.startsWith(prev.transcriptText)) {
			const diffText = block.transcriptText
				.substring(prev.transcriptText.length)
				.trim();
			if (diffText) {
				return { ...block, transcriptText: diffText };
			}
			return block;
		}

		const overlap = longestSuffixPrefixOverlap(
			prev.transcriptText,
			block.transcriptText,
		);
		if (overlap > 0) {
			const diffText = block.transcriptText.substring(overlap).trim();
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

/**
 * Build the clipboard text for a session copy action.
 * Uses the deduplicated transcript; the raw caption log contains one entry
 * per DOM mutation (intermediate snapshots of the same utterance), so it is
 * only used as a fallback when no blocks were ever committed.
 */
export function formatSessionCopyText(
	transcript: TranscriptBlock[],
	rawTranscript: RawCaptionEntry[],
	formatTimeFn: (iso: string) => string = formatTimeOnly,
): string {
	if (transcript.length > 0) {
		return formatTranscriptAsText(transcript, formatTimeFn);
	}
	if (rawTranscript.length > 0) {
		return formatRawTranscriptAsText(rawTranscript, formatTimeFn);
	}
	return "";
}

/**
 * Check whether new DOM text is an accumulated version of already-committed text.
 * Returns `{ text, skip }` where `text` is the portion to process and `skip`
 * indicates the entry should be skipped entirely (exact re-observation).
 */
export function trimAccumulatedPrefix(
	newText: string,
	lastDomText: string | undefined,
): { text: string; skip: boolean } {
	if (!lastDomText) return { text: newText, skip: false };
	if (newText === lastDomText) return { text: newText, skip: true };
	if (newText.startsWith(lastDomText)) {
		const newPart = newText.substring(lastDomText.length).trim();
		if (!newPart) return { text: newText, skip: true };
		return { text: newPart, skip: false };
	}

	// Fuzzy match: speech recognition may revise the tail of the committed
	// text ("〜です。" → "〜ですね。") while continuing to accumulate.
	// Retry with trailing punctuation stripped from the committed text.
	const stripped = stripTrailingPunctuation(lastDomText);
	if (stripped && stripped !== lastDomText && newText.startsWith(stripped)) {
		const newPart = newText.substring(stripped.length).trim();
		if (!newPart) return { text: newText, skip: true };
		return { text: newPart, skip: false };
	}

	// LCP-based match: when the new text is longer and shares ≥80% prefix
	// with the committed text, treat the common part as already committed.
	if (newText.length > lastDomText.length) {
		const lcp = longestCommonPrefixLength(newText, lastDomText);
		if (lcp >= lastDomText.length * LCP_ABSORPTION_RATIO) {
			const newPart = newText.substring(lcp).trim();
			if (!newPart) return { text: newText, skip: true };
			return { text: newPart, skip: false };
		}
	}

	return { text: newText, skip: false };
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

/**
 * Format a byte count as a human-readable string (e.g. "12.3 MB").
 * Bytes are shown as integers; larger units with one decimal place.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${Math.round(bytes)} B`;

	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = -1;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
