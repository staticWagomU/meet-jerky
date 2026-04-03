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
