import type { TranscriptionEngineType } from "../types";
import { STATUS_UNCHECKABLE_LABEL } from "./statusLabels";

export function getEngineStatusLabel(
  engine: TranscriptionEngineType | undefined,
): string {
  if (!engine) {
    return "確認中";
  }
  if (engine === "appleSpeech") {
    return "Apple Speech（端末内）";
  }
  if (engine === "openAIRealtime") {
    return "OpenAI Realtime";
  }
  if (engine === "elevenLabsRealtime") {
    return "ElevenLabs Realtime";
  }
  return "Whisper（端末内）";
}

export function getEngineStatusDisplayLabel(statusLabel: string): string {
  if (statusLabel === "Apple Speech（端末内）") {
    return "Apple Speech";
  }
  if (statusLabel === "OpenAI Realtime") {
    return "OpenAI";
  }
  if (statusLabel === "ElevenLabs Realtime") {
    return "ElevenLabs";
  }
  if (statusLabel === "Whisper（端末内）") {
    return "Whisper";
  }
  return statusLabel;
}

export function getEngineStatusPillClass(statusLabel: string): string {
  if (statusLabel === STATUS_UNCHECKABLE_LABEL) {
    return "meeting-status-pill-error";
  }
  if (statusLabel === "確認中") {
    return "meeting-status-pill-neutral";
  }
  return "meeting-status-pill-active";
}
