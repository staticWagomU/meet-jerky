import type { TranscriptBlock } from './types';

export type MessageType =
  | 'MEETING_STARTED'
  | 'TRANSCRIPT_UPDATE'
  | 'MEETING_ENDED'
  | 'GET_SESSIONS'
  | 'GET_TRANSCRIPT'
  | 'DELETE_SESSION';

export interface MeetingStartedMessage {
  type: 'MEETING_STARTED';
  payload: {
    sessionId: string;
    meetingCode: string;
    meetingTitle: string;
    startTimestamp: string;
  };
}

export interface TranscriptUpdateMessage {
  type: 'TRANSCRIPT_UPDATE';
  payload: {
    sessionId: string;
    blocks: TranscriptBlock[];
  };
}

export interface MeetingEndedMessage {
  type: 'MEETING_ENDED';
  payload: {
    sessionId: string;
  };
}

export interface GetSessionsMessage {
  type: 'GET_SESSIONS';
}

export interface GetTranscriptMessage {
  type: 'GET_TRANSCRIPT';
  payload: {
    sessionId: string;
  };
}

export interface DeleteSessionMessage {
  type: 'DELETE_SESSION';
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
  | DeleteSessionMessage;
