/** A single caption observation: speaker name + current text (no timestamp). */
export interface CaptionData {
	personName: string;
	text: string;
}

export interface TranscriptBlock {
	personName: string;
	timestamp: string;
	transcriptText: string;
}

export interface RawCaptionEntry {
	timestamp: string;
	personName: string;
	text: string;
}

/** AI-generated summary cached on the session to avoid re-billing. */
export interface AiSummary {
	text: string;
	model: string;
	generatedAt: string;
}

export interface MeetingSession {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
	transcript: TranscriptBlock[];
	rawTranscript: RawCaptionEntry[];
	/** Pinned sessions are exempt from all retention cleanup. */
	pinned?: boolean;
	aiSummary?: AiSummary;
	/** Set once the meeting-end auto download succeeded, so a second
	 *  MEETING_ENDED (or a tab close after leaving) does not re-download. */
	autoDownloadedAt?: string;
}

/** File format for the transcript file written on meeting end. */
export type DownloadFormat = "txt" | "md" | "json";

export interface AutoDownloadSettings {
	enabled: boolean;
	format: DownloadFormat;
	/** Path relative to the browser download folder. Empty = folder root. */
	subfolder: string;
	/** Show the browser's save dialog instead of saving silently. */
	saveAs: boolean;
}

export interface UserSettings {
	retention: {
		mode: "count" | "days";
		maxCount: number;
		maxDays: number;
	};
	ai: {
		apiKey: string;
		model: string;
		customPrompt: string;
	};
	autoDownload: AutoDownloadSettings;
}
