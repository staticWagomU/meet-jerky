import type { RawCaptionEntry, TranscriptBlock } from "./types";

export type MessageType =
	| "MEETING_STARTED"
	| "TRANSCRIPT_UPDATE"
	| "MEETING_ENDED"
	| "GET_SESSIONS"
	| "GET_TRANSCRIPT"
	| "DELETE_SESSION"
	| "UPDATE_SESSION_TITLE"
	| "KEEPALIVE";

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

export interface KeepaliveMessage {
	type: "KEEPALIVE";
}

export type ExtensionMessage =
	| MeetingStartedMessage
	| TranscriptUpdateMessage
	| MeetingEndedMessage
	| GetSessionsMessage
	| GetTranscriptMessage
	| DeleteSessionMessage
	| UpdateSessionTitleMessage
	| KeepaliveMessage;
