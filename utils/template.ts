import {
	computeTranscriptDiffs,
	extractParticipants,
	formatTimeOnly,
	getSessionDisplayTitle,
} from "./helpers";
import type { MeetingSession } from "./types";

export const DEFAULT_MINUTES_TEMPLATE = `# {{title}}

- 日時: {{date}} {{startTime}} 〜 {{endTime}}（{{duration}}）
- 参加者（{{participantCount}}名）: {{participants}}

---

## 議事録

{{transcript}}

---

## 決定事項

-

## TODO

-
`;

export interface TemplateContext {
	title: string;
	code: string;
	date: string;
	startTime: string;
	endTime: string;
	duration: string;
	participants: string;
	participantCount: string;
	transcriptCount: string;
	transcript: string;
}

/**
 * Format an ISO timestamp as "YYYY年MM月DD日".
 */
function formatDateOnly(isoString: string): string {
	const d = new Date(isoString);
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * Format an ISO timestamp as "HH:MM" (without seconds).
 */
function formatTimeHHMM(isoString: string): string {
	const d = new Date(isoString);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/**
 * Format duration between two ISO timestamps as a human-readable Japanese string.
 * Examples: "1時間30分", "45分", "0分"
 */
export function formatDuration(
	startTimestamp: string,
	endTimestamp: string,
): string {
	const startMs = new Date(startTimestamp).getTime();
	const endMs = new Date(endTimestamp).getTime();
	const diffMs = Math.max(0, endMs - startMs);
	const totalMinutes = Math.floor(diffMs / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0 && minutes > 0) {
		return `${hours}時間${minutes}分`;
	}
	if (hours > 0) {
		return `${hours}時間`;
	}
	return `${minutes}分`;
}

/**
 * Build a TemplateContext from a MeetingSession.
 */
export function buildTemplateContext(session: MeetingSession): TemplateContext {
	const participants = extractParticipants(session.transcript);
	const diffed = computeTranscriptDiffs(session.transcript);

	const transcript = diffed
		.map((block) => {
			const time = formatTimeOnly(block.timestamp);
			return `**${block.personName}** (${time})\n${block.transcriptText}`;
		})
		.join("\n\n");

	return {
		title: getSessionDisplayTitle(session),
		code: session.meetingCode,
		date: session.startTimestamp ? formatDateOnly(session.startTimestamp) : "",
		startTime: session.startTimestamp
			? formatTimeHHMM(session.startTimestamp)
			: "",
		endTime: session.endTimestamp ? formatTimeHHMM(session.endTimestamp) : "",
		duration:
			session.startTimestamp && session.endTimestamp
				? formatDuration(session.startTimestamp, session.endTimestamp)
				: "0分",
		participants: participants.join(", "),
		participantCount: String(participants.length),
		transcriptCount: String(session.transcript.length),
		transcript,
	};
}

/**
 * Expand a template string by replacing {{varName}} placeholders with context values.
 * Unknown variables are replaced with empty strings.
 */
export function expandTemplate(
	template: string,
	context: TemplateContext,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		if (key in context) {
			return context[key as keyof TemplateContext];
		}
		return "";
	});
}

/**
 * Generate minutes from a MeetingSession using a template.
 * Falls back to DEFAULT_MINUTES_TEMPLATE if template is empty or not provided.
 */
export function generateMinutes(
	session: MeetingSession,
	template?: string,
): string {
	const tmpl = template || DEFAULT_MINUTES_TEMPLATE;
	const context = buildTemplateContext(session);
	return expandTemplate(tmpl, context);
}
