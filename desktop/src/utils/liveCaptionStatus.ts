import type { TranscriptionEngineType } from "../types";
import { CONTROL_CHARACTER_PATTERN } from "./transcriptSegment";
import { STATUS_CHECKING_LABEL, STATUS_UNDETERMINED_LABEL } from "./statusLabels";

export const LIVE_CAPTION_STATUS_EVENT = "live-caption-status";
export const LIVE_CAPTION_STATUS_STORAGE_KEY = "meet-jerky-live-caption-status";
const EXTERNAL_TRANSMISSION_LABELS = new Set([
  "送信先 OpenAI",
  "送信先 ElevenLabs",
]);
const MAX_STATUS_LABEL_LENGTH = 80;

function toValidStatusLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_STATUS_LABEL_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function statusLabelOrDefault(value: unknown, fallback: string): string {
  return toValidStatusLabel(value) ?? fallback;
}

export interface LiveCaptionStatusPayload {
  engineLabel: string;
  aiTransmissionLabel: string;
  isExternalTransmission: boolean;
  transcriptionStatusLabel: string;
  microphoneTrackLabel: string;
  systemAudioTrackLabel: string;
}

type StoredLiveCaptionStatusPayload = Omit<
  LiveCaptionStatusPayload,
  "transcriptionStatusLabel" | "microphoneTrackLabel" | "systemAudioTrackLabel"
> &
  Partial<
    Pick<
      LiveCaptionStatusPayload,
      | "transcriptionStatusLabel"
      | "microphoneTrackLabel"
      | "systemAudioTrackLabel"
    >
  >;

export const DEFAULT_LIVE_CAPTION_STATUS: LiveCaptionStatusPayload = {
  engineLabel: STATUS_CHECKING_LABEL,
  aiTransmissionLabel: STATUS_CHECKING_LABEL,
  isExternalTransmission: false,
  transcriptionStatusLabel: "停止中",
  microphoneTrackLabel: STATUS_UNDETERMINED_LABEL,
  systemAudioTrackLabel: STATUS_UNDETERMINED_LABEL,
};

export function isLiveCaptionStatusPayload(
  value: unknown,
): value is StoredLiveCaptionStatusPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LiveCaptionStatusPayload>;
  return (
    toValidStatusLabel(candidate.engineLabel) !== null &&
    toValidStatusLabel(candidate.aiTransmissionLabel) !== null &&
    typeof candidate.isExternalTransmission === "boolean" &&
    (candidate.transcriptionStatusLabel === undefined ||
      toValidStatusLabel(candidate.transcriptionStatusLabel) !== null) &&
    (candidate.microphoneTrackLabel === undefined ||
      toValidStatusLabel(candidate.microphoneTrackLabel) !== null) &&
    (candidate.systemAudioTrackLabel === undefined ||
      toValidStatusLabel(candidate.systemAudioTrackLabel) !== null)
  );
}

export function getLiveCaptionStatusPayloadIssue(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload がオブジェクトではありません";
  }
  const candidate = value as Partial<LiveCaptionStatusPayload>;
  if (toValidStatusLabel(candidate.engineLabel) === null) {
    return "engineLabel が空、長すぎる、または制御文字を含みます";
  }
  if (toValidStatusLabel(candidate.aiTransmissionLabel) === null) {
    return "aiTransmissionLabel が空、長すぎる、または制御文字を含みます";
  }
  if (typeof candidate.isExternalTransmission !== "boolean") {
    return "isExternalTransmission が boolean ではありません";
  }
  if (
    candidate.transcriptionStatusLabel !== undefined &&
    toValidStatusLabel(candidate.transcriptionStatusLabel) === null
  ) {
    return "transcriptionStatusLabel が空、長すぎる、または制御文字を含みます";
  }
  if (
    candidate.microphoneTrackLabel !== undefined &&
    toValidStatusLabel(candidate.microphoneTrackLabel) === null
  ) {
    return "microphoneTrackLabel が空、長すぎる、または制御文字を含みます";
  }
  if (
    candidate.systemAudioTrackLabel !== undefined &&
    toValidStatusLabel(candidate.systemAudioTrackLabel) === null
  ) {
    return "systemAudioTrackLabel が空、長すぎる、または制御文字を含みます";
  }
  return "形式が不正です";
}

export function normalizeLiveCaptionStatusPayload(
  status: StoredLiveCaptionStatusPayload,
): LiveCaptionStatusPayload {
  const engineLabel = statusLabelOrDefault(
    status.engineLabel,
    DEFAULT_LIVE_CAPTION_STATUS.engineLabel,
  );
  const aiTransmissionLabel = statusLabelOrDefault(
    status.aiTransmissionLabel,
    DEFAULT_LIVE_CAPTION_STATUS.aiTransmissionLabel,
  );
  return {
    engineLabel,
    aiTransmissionLabel,
    isExternalTransmission:
      status.isExternalTransmission ||
      isExternalTransmissionLabel(aiTransmissionLabel),
    transcriptionStatusLabel: statusLabelOrDefault(
      status.transcriptionStatusLabel,
      DEFAULT_LIVE_CAPTION_STATUS.transcriptionStatusLabel,
    ),
    microphoneTrackLabel: statusLabelOrDefault(
      status.microphoneTrackLabel,
      DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
    ),
    systemAudioTrackLabel: statusLabelOrDefault(
      status.systemAudioTrackLabel,
      DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    ),
  };
}

export function readStoredLiveCaptionStatus(
  onError?: (error: unknown) => void,
): LiveCaptionStatusPayload {
  try {
    const raw = localStorage.getItem(LIVE_CAPTION_STATUS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_LIVE_CAPTION_STATUS;
    }
    const parsed: unknown = JSON.parse(raw);
    return isLiveCaptionStatusPayload(parsed)
      ? normalizeLiveCaptionStatusPayload(parsed)
      : DEFAULT_LIVE_CAPTION_STATUS;
  } catch (e) {
    onError?.(e);
    return DEFAULT_LIVE_CAPTION_STATUS;
  }
}

export function writeStoredLiveCaptionStatus(
  status: LiveCaptionStatusPayload,
  onError?: (error: unknown) => void,
): boolean {
  try {
    localStorage.setItem(LIVE_CAPTION_STATUS_STORAGE_KEY, JSON.stringify(status));
    return true;
  } catch (e) {
    onError?.(e);
    return false;
  }
}

export function getVisibleTransmissionLabel(
  status: LiveCaptionStatusPayload,
): string {
  if (status.isExternalTransmission) {
    return "外部送信";
  }
  if (status.aiTransmissionLabel === "なし") {
    return "端末内";
  }
  return status.aiTransmissionLabel;
}

export function getTransmissionStatusAriaLabel(
  status: LiveCaptionStatusPayload,
): string {
  if (status.isExternalTransmission) {
    return `外部送信: ${status.aiTransmissionLabel}`;
  }
  return "外部送信なし、端末内で処理";
}

export function isExternalTransmissionLabel(label: string): boolean {
  return EXTERNAL_TRANSMISSION_LABELS.has(label.trim());
}

export function buildLiveCaptionStatusFromEngine(
  engine: TranscriptionEngineType | undefined,
): LiveCaptionStatusPayload {
  if (engine === "openAIRealtime") {
    return {
      engineLabel: "OpenAI",
      aiTransmissionLabel: "送信先 OpenAI",
      isExternalTransmission: true,
      transcriptionStatusLabel:
        DEFAULT_LIVE_CAPTION_STATUS.transcriptionStatusLabel,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  if (engine === "elevenLabsRealtime") {
    return {
      engineLabel: "ElevenLabs",
      aiTransmissionLabel: "送信先 ElevenLabs",
      isExternalTransmission: true,
      transcriptionStatusLabel:
        DEFAULT_LIVE_CAPTION_STATUS.transcriptionStatusLabel,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  if (engine === "appleSpeech") {
    return {
      engineLabel: "Apple Speech",
      aiTransmissionLabel: "なし",
      isExternalTransmission: false,
      transcriptionStatusLabel:
        DEFAULT_LIVE_CAPTION_STATUS.transcriptionStatusLabel,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  if (engine === "whisper") {
    return {
      engineLabel: "Whisper",
      aiTransmissionLabel: "なし",
      isExternalTransmission: false,
      transcriptionStatusLabel:
        DEFAULT_LIVE_CAPTION_STATUS.transcriptionStatusLabel,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  return DEFAULT_LIVE_CAPTION_STATUS;
}

export function buildLiveCaptionStatusFromLabels(
  engineLabel: string,
  aiTransmissionLabel: string,
  trackLabels?: {
    transcriptionStatusLabel?: string;
    microphoneTrackLabel: string;
    systemAudioTrackLabel: string;
  },
): LiveCaptionStatusPayload {
  const normalizedAiTransmissionLabel = statusLabelOrDefault(
    aiTransmissionLabel,
    DEFAULT_LIVE_CAPTION_STATUS.aiTransmissionLabel,
  );
  return {
    engineLabel: statusLabelOrDefault(
      engineLabel,
      DEFAULT_LIVE_CAPTION_STATUS.engineLabel,
    ),
    aiTransmissionLabel: normalizedAiTransmissionLabel,
    isExternalTransmission: isExternalTransmissionLabel(
      normalizedAiTransmissionLabel,
    ),
    transcriptionStatusLabel: statusLabelOrDefault(
      trackLabels?.transcriptionStatusLabel,
      DEFAULT_LIVE_CAPTION_STATUS.transcriptionStatusLabel,
    ),
    microphoneTrackLabel: statusLabelOrDefault(
      trackLabels?.microphoneTrackLabel,
      DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
    ),
    systemAudioTrackLabel: statusLabelOrDefault(
      trackLabels?.systemAudioTrackLabel,
      DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    ),
  };
}
