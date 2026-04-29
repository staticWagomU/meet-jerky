import type { TranscriptionEngineType } from "../types";

export const LIVE_CAPTION_STATUS_EVENT = "live-caption-status";
export const LIVE_CAPTION_STATUS_STORAGE_KEY = "meet-jerky-live-caption-status";
const EXTERNAL_TRANSMISSION_LABELS = new Set([
  "送信先 OpenAI",
  "送信先 ElevenLabs",
]);

export interface LiveCaptionStatusPayload {
  engineLabel: string;
  aiTransmissionLabel: string;
  isExternalTransmission: boolean;
  microphoneTrackLabel: string;
  systemAudioTrackLabel: string;
}

type StoredLiveCaptionStatusPayload = Omit<
  LiveCaptionStatusPayload,
  "microphoneTrackLabel" | "systemAudioTrackLabel"
> &
  Partial<
    Pick<
      LiveCaptionStatusPayload,
      "microphoneTrackLabel" | "systemAudioTrackLabel"
    >
  >;

export const DEFAULT_LIVE_CAPTION_STATUS: LiveCaptionStatusPayload = {
  engineLabel: "確認中",
  aiTransmissionLabel: "確認中",
  isExternalTransmission: false,
  microphoneTrackLabel: "未確認",
  systemAudioTrackLabel: "未確認",
};

export function isLiveCaptionStatusPayload(
  value: unknown,
): value is StoredLiveCaptionStatusPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LiveCaptionStatusPayload>;
  return (
    typeof candidate.engineLabel === "string" &&
    typeof candidate.aiTransmissionLabel === "string" &&
    typeof candidate.isExternalTransmission === "boolean" &&
    (candidate.microphoneTrackLabel === undefined ||
      typeof candidate.microphoneTrackLabel === "string") &&
    (candidate.systemAudioTrackLabel === undefined ||
      typeof candidate.systemAudioTrackLabel === "string")
  );
}

export function normalizeLiveCaptionStatusPayload(
  status: StoredLiveCaptionStatusPayload,
): LiveCaptionStatusPayload {
  return {
    ...DEFAULT_LIVE_CAPTION_STATUS,
    ...status,
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
  return EXTERNAL_TRANSMISSION_LABELS.has(label);
}

export function buildLiveCaptionStatusFromEngine(
  engine: TranscriptionEngineType | undefined,
): LiveCaptionStatusPayload {
  if (engine === "openAIRealtime") {
    return {
      engineLabel: "OpenAI",
      aiTransmissionLabel: "送信先 OpenAI",
      isExternalTransmission: true,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  if (engine === "elevenLabsRealtime") {
    return {
      engineLabel: "ElevenLabs",
      aiTransmissionLabel: "送信先 ElevenLabs",
      isExternalTransmission: true,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  if (engine === "appleSpeech") {
    return {
      engineLabel: "Apple Speech",
      aiTransmissionLabel: "なし",
      isExternalTransmission: false,
      microphoneTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
      systemAudioTrackLabel: DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
    };
  }
  if (engine === "whisper") {
    return {
      engineLabel: "Whisper",
      aiTransmissionLabel: "なし",
      isExternalTransmission: false,
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
    microphoneTrackLabel: string;
    systemAudioTrackLabel: string;
  },
): LiveCaptionStatusPayload {
  return {
    engineLabel,
    aiTransmissionLabel,
    isExternalTransmission: isExternalTransmissionLabel(aiTransmissionLabel),
    microphoneTrackLabel:
      trackLabels?.microphoneTrackLabel ??
      DEFAULT_LIVE_CAPTION_STATUS.microphoneTrackLabel,
    systemAudioTrackLabel:
      trackLabels?.systemAudioTrackLabel ??
      DEFAULT_LIVE_CAPTION_STATUS.systemAudioTrackLabel,
  };
}
