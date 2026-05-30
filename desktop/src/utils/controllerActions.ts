import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";
import {
  LIVE_CAPTION_STATUS_EVENT,
  LOCAL_AUDIO_TRANSMISSION_LABEL,
  type LiveCaptionStatusPayload,
} from "./liveCaptionStatus";
import {
  LIVE_CAPTION_RESET_EVENT,
  TRANSCRIPTION_ERROR_EVENT,
  TRANSCRIPTION_RESULT_EVENT,
} from "./transcriptionEvents";
import {
  markControllerMeetingStartRequest,
  MEETING_START_REQUEST_EVENT,
} from "./meetingStartRequest";
import {
  RING_LIGHT_MODE_EVENT,
  type RingLightMode,
  type RingLightModePayload,
} from "./ringLight";

// App.tsx がローカル定義しているメイン表示要求イベント名と同一にする。
export const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";

// サンプルは公開 interface に型付けし、既存バリデータを通る形を tsc で静的保証する。
export const SAMPLE_TRANSCRIPT_SEGMENT: TranscriptSegment = {
  text: "検証パネルから流したテスト文字起こしです。",
  startMs: 0,
  endMs: 1500,
  source: "microphone",
  speaker: "自分",
};

export const SAMPLE_TRANSCRIPTION_ERROR: TranscriptionErrorPayload = {
  error: "検証パネルから表示したテストエラーです。",
  source: "system_audio",
};

export const SAMPLE_LIVE_CAPTION_STATUS: LiveCaptionStatusPayload = {
  engineLabel: "Whisper",
  aiTransmissionLabel: LOCAL_AUDIO_TRANSMISSION_LABEL,
  isExternalTransmission: false,
  transcriptionStatusLabel: "文字起こし中",
  microphoneTrackLabel: "録音中",
  systemAudioTrackLabel: "録音中",
};

// 会議検出は実アプリと同じ payload 構築経路を通して再現する。
export async function triggerMeetingDetection(
  kind: "app" | "browser",
): Promise<void> {
  await invoke("debug_emit_meeting_detected", { kind });
}

export async function setMeetingPromptVisible(visible: boolean): Promise<void> {
  await invoke("set_meeting_prompt_window_visible", { visible });
}

export async function setLiveCaptionVisible(visible: boolean): Promise<void> {
  await invoke("set_live_caption_window_visible", { visible });
}

export async function setRingLightVisible(visible: boolean): Promise<void> {
  await invoke("set_ring_light_visible", { visible });
}

export async function showMainWindow(): Promise<void> {
  await invoke("show_main_window");
}

export async function emitLiveCaptionStatus(): Promise<void> {
  await emit(LIVE_CAPTION_STATUS_EVENT, SAMPLE_LIVE_CAPTION_STATUS);
}

export async function emitTranscriptionResult(): Promise<void> {
  await emit(TRANSCRIPTION_RESULT_EVENT, SAMPLE_TRANSCRIPT_SEGMENT);
}

export async function emitTranscriptionError(): Promise<void> {
  await emit(TRANSCRIPTION_ERROR_EVENT, SAMPLE_TRANSCRIPTION_ERROR);
}

export async function emitLiveCaptionReset(): Promise<void> {
  await emit(LIVE_CAPTION_RESET_EVENT);
}

export async function emitRingLightMode(mode: RingLightMode): Promise<void> {
  const payload: RingLightModePayload = { mode };
  await emit(RING_LIGHT_MODE_EVENT, payload);
}

export async function emitMeetingStartRequest(): Promise<void> {
  markControllerMeetingStartRequest();
  await emit(MEETING_START_REQUEST_EVENT);
}

export async function emitShowMainRequest(): Promise<void> {
  await emit(SHOW_MAIN_WINDOW_REQUEST_EVENT);
}
