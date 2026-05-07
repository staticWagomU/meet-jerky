import type { TranscriptionEngineType } from "../types";
import { STATUS_CHECKING_LABEL, STATUS_UNCHECKABLE_LABEL } from "./statusLabels";

type EngineStatusLabelOptions = {
  isModelDownloaded?: boolean;
  modelDownloadedError?: unknown;
};

const ENGINE_STATUS_LABELS = {
  appleSpeech: "Apple Speech（端末内）",
  openAIRealtime: "OpenAI Realtime",
  elevenLabsRealtime: "ElevenLabs Realtime",
  whisperUnavailable: "Whisper（モデル確認不可）",
  whisperChecking: "Whisper（モデル確認中）",
  whisperNotDownloaded: "Whisper（未ダウンロード）",
  whisperLocal: "Whisper（端末内）",
} as const;

type KnownEngineStatusLabel =
  (typeof ENGINE_STATUS_LABELS)[keyof typeof ENGINE_STATUS_LABELS];

type MeetingStatusPillClass =
  | "meeting-status-pill-active"
  | "meeting-status-pill-error"
  | "meeting-status-pill-neutral";

type EngineStatusMetadata = {
  displayLabel: string;
  pillClass: MeetingStatusPillClass;
};

const ENGINE_STATUS_METADATA = {
  [ENGINE_STATUS_LABELS.appleSpeech]: {
    displayLabel: "Apple Speech",
    pillClass: "meeting-status-pill-active",
  },
  [ENGINE_STATUS_LABELS.openAIRealtime]: {
    displayLabel: "OpenAI",
    pillClass: "meeting-status-pill-active",
  },
  [ENGINE_STATUS_LABELS.elevenLabsRealtime]: {
    displayLabel: "ElevenLabs",
    pillClass: "meeting-status-pill-active",
  },
  [ENGINE_STATUS_LABELS.whisperUnavailable]: {
    displayLabel: "Whisper 確認不可",
    pillClass: "meeting-status-pill-error",
  },
  [ENGINE_STATUS_LABELS.whisperChecking]: {
    displayLabel: "Whisper 確認中",
    pillClass: "meeting-status-pill-neutral",
  },
  [ENGINE_STATUS_LABELS.whisperNotDownloaded]: {
    displayLabel: "Whisper 未DL",
    pillClass: "meeting-status-pill-error",
  },
  [ENGINE_STATUS_LABELS.whisperLocal]: {
    displayLabel: "Whisper",
    pillClass: "meeting-status-pill-active",
  },
} as const satisfies Record<KnownEngineStatusLabel, EngineStatusMetadata>;

const ENGINE_STATUS_FALLBACK_PILL_CLASSES = {
  [STATUS_UNCHECKABLE_LABEL]: "meeting-status-pill-error",
  [STATUS_CHECKING_LABEL]: "meeting-status-pill-neutral",
} as const satisfies Record<
  typeof STATUS_UNCHECKABLE_LABEL | typeof STATUS_CHECKING_LABEL,
  MeetingStatusPillClass
>;

type EngineStatusFallbackPillLabel =
  keyof typeof ENGINE_STATUS_FALLBACK_PILL_CLASSES;

function isKnownEngineStatusLabel(
  statusLabel: string,
): statusLabel is KnownEngineStatusLabel {
  return statusLabel in ENGINE_STATUS_METADATA;
}

function isEngineStatusFallbackPillLabel(
  statusLabel: string,
): statusLabel is EngineStatusFallbackPillLabel {
  return statusLabel in ENGINE_STATUS_FALLBACK_PILL_CLASSES;
}

export function getEngineStatusLabel(
  engine: TranscriptionEngineType | undefined,
  options: EngineStatusLabelOptions = {},
): string {
  if (!engine) {
    return STATUS_CHECKING_LABEL;
  }
  if (engine === "appleSpeech") {
    return ENGINE_STATUS_LABELS.appleSpeech;
  }
  if (engine === "openAIRealtime") {
    return ENGINE_STATUS_LABELS.openAIRealtime;
  }
  if (engine === "elevenLabsRealtime") {
    return ENGINE_STATUS_LABELS.elevenLabsRealtime;
  }
  if (options.modelDownloadedError) {
    return ENGINE_STATUS_LABELS.whisperUnavailable;
  }
  if (options.isModelDownloaded === undefined) {
    return ENGINE_STATUS_LABELS.whisperChecking;
  }
  if (options.isModelDownloaded === false) {
    return ENGINE_STATUS_LABELS.whisperNotDownloaded;
  }
  return ENGINE_STATUS_LABELS.whisperLocal;
}

export function getEngineStatusDisplayLabel(statusLabel: string): string {
  if (isKnownEngineStatusLabel(statusLabel)) {
    return ENGINE_STATUS_METADATA[statusLabel].displayLabel;
  }
  return statusLabel;
}

export function getEngineStatusPillClass(statusLabel: string): string {
  if (isEngineStatusFallbackPillLabel(statusLabel)) {
    return ENGINE_STATUS_FALLBACK_PILL_CLASSES[statusLabel];
  }
  if (isKnownEngineStatusLabel(statusLabel)) {
    return ENGINE_STATUS_METADATA[statusLabel].pillClass;
  }
  return "meeting-status-pill-active";
}
