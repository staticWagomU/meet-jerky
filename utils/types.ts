export interface TranscriptBlock {
  personName: string;
  timestamp: string;
  transcriptText: string;
}

export interface MeetingSession {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  startTimestamp: string;
  endTimestamp: string;
  transcript: TranscriptBlock[];
}
