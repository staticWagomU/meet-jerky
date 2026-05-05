import type { TranscriptionEngineType } from "../types";
import { isExternalTransmissionLabel } from "./liveCaptionStatus";

export function getAiTransmissionStatusLabel(
  engine: TranscriptionEngineType | undefined,
): string {
  if (!engine) {
    return "確認中";
  }
  if (engine === "openAIRealtime") {
    return "送信先 OpenAI";
  }
  if (engine === "elevenLabsRealtime") {
    return "送信先 ElevenLabs";
  }
  return "なし";
}

export function getAiTransmissionStatusPillClass(statusLabel: string): string {
  if (isExternalTransmissionLabel(statusLabel)) {
    return "meeting-status-pill-warning";
  }
  if (statusLabel === "確認できません") {
    return "meeting-status-pill-error";
  }
  if (statusLabel === "なし") {
    return "meeting-status-pill-idle";
  }
  return "meeting-status-pill-neutral";
}

export function getAiTransmissionStatusAriaLabel(statusLabel: string): string {
  if (statusLabel === "確認できません") {
    return "外部送信状態を確認できません";
  }
  if (statusLabel === "なし") {
    return "外部送信なし、端末内で処理";
  }
  return `外部送信: ${statusLabel}`;
}
