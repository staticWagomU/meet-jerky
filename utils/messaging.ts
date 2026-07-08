import type { AiSummary, RawCaptionEntry, TranscriptBlock } from "./types";

export type MessageType =
	| "MEETING_STARTED"
	| "TRANSCRIPT_UPDATE"
	| "MEETING_ENDED"
	| "GET_SESSIONS"
	| "GET_TRANSCRIPT"
	| "DELETE_SESSION"
	| "UPDATE_SESSION_TITLE"
	| "UPDATE_SESSION_PIN"
	| "UPDATE_SESSION_SUMMARY"
	| "KEEPALIVE"
	| "SESSIONS_CHANGED";

export interface MeetingStartedMessage {
	type: "MEETING_STARTED";
	payload: {
		sessionId: string;
		meetingCode: string;
		meetingTitle: string;
		startTimestamp: string;
	};
}

export interface TranscriptUpdateMessage {
	type: "TRANSCRIPT_UPDATE";
	payload: {
		sessionId: string;
		blocks: TranscriptBlock[];
		rawEntries: RawCaptionEntry[];
	};
}

export interface MeetingEndedMessage {
	type: "MEETING_ENDED";
	payload: {
		sessionId: string;
	};
}

export interface GetSessionsMessage {
	type: "GET_SESSIONS";
}

export interface GetTranscriptMessage {
	type: "GET_TRANSCRIPT";
	payload: {
		sessionId: string;
	};
}

export interface DeleteSessionMessage {
	type: "DELETE_SESSION";
	payload: {
		sessionId: string;
	};
}

export interface UpdateSessionTitleMessage {
	type: "UPDATE_SESSION_TITLE";
	payload: {
		sessionId: string;
		meetingTitle: string;
	};
}

export interface UpdateSessionPinMessage {
	type: "UPDATE_SESSION_PIN";
	payload: {
		sessionId: string;
		pinned: boolean;
	};
}

export interface UpdateSessionSummaryMessage {
	type: "UPDATE_SESSION_SUMMARY";
	payload: {
		sessionId: string;
		aiSummary: AiSummary;
	};
}

export interface KeepaliveMessage {
	type: "KEEPALIVE";
}

/** Broadcast from background to extension pages (popup / side panel)
 *  whenever session data changes, so open views can refresh live. */
export interface SessionsChangedMessage {
	type: "SESSIONS_CHANGED";
	payload: {
		sessionId: string;
	};
}

export type ExtensionMessage =
	| MeetingStartedMessage
	| TranscriptUpdateMessage
	| MeetingEndedMessage
	| GetSessionsMessage
	| GetTranscriptMessage
	| DeleteSessionMessage
	| UpdateSessionTitleMessage
	| UpdateSessionPinMessage
	| UpdateSessionSummaryMessage
	| KeepaliveMessage
	| SessionsChangedMessage;
