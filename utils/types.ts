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

export interface MeetingSession {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
	transcript: TranscriptBlock[];
	rawTranscript: RawCaptionEntry[];
}

export type AIProvider = "openai" | "anthropic" | "gemini";

export interface UserSettings {
	retention: {
		mode: "count" | "days";
		maxCount: number;
		maxDays: number;
	};
	google: { authenticated: boolean };
	template: { minutesTemplate: string; customPrompt: string };
	ai: {
		provider: AIProvider;
		apiKey: string;
	};
}
