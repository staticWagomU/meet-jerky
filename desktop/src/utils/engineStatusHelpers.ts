import type { TranscriptionEngineType } from "../types";
import { STATUS_CHECKING_LABEL, STATUS_UNCHECKABLE_LABEL } from "./statusLabels";

type EngineStatusLabelOptions = {
  isModelDownloaded?: boolean;
  modelDownloadedError?: unknown;
};

export function getEngineStatusLabel(
  engine: TranscriptionEngineType | undefined,
  options: EngineStatusLabelOptions = {},
): string {
  if (!engine) {
    return STATUS_CHECKING_LABEL;
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
  if (options.modelDownloadedError) {
    return "Whisper（モデル確認不可）";
  }
  if (options.isModelDownloaded === undefined) {
    return "Whisper（モデル確認中）";
  }
  if (options.isModelDownloaded === false) {
    return "Whisper（未ダウンロード）";
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
  if (statusLabel === "Whisper（モデル確認中）") {
    return "Whisper 確認中";
  }
  if (statusLabel === "Whisper（未ダウンロード）") {
    return "Whisper 未DL";
  }
  if (statusLabel === "Whisper（モデル確認不可）") {
    return "Whisper 確認不可";
  }
  return statusLabel;
}

export function getEngineStatusPillClass(statusLabel: string): string {
  if (statusLabel === STATUS_UNCHECKABLE_LABEL) {
    return "meeting-status-pill-error";
  }
  if (statusLabel === STATUS_CHECKING_LABEL) {
    return "meeting-status-pill-neutral";
  }
  if (statusLabel === "Whisper（モデル確認中）") {
    return "meeting-status-pill-neutral";
  }
  if (
    statusLabel === "Whisper（未ダウンロード）" ||
    statusLabel === "Whisper（モデル確認不可）"
  ) {
    return "meeting-status-pill-error";
  }
  return "meeting-status-pill-active";
}
