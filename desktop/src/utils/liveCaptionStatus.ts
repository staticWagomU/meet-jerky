export const LIVE_CAPTION_STATUS_EVENT = "live-caption-status";
export const LIVE_CAPTION_STATUS_STORAGE_KEY = "meet-jerky-live-caption-status";

export interface LiveCaptionStatusPayload {
  engineLabel: string;
  aiTransmissionLabel: string;
  isExternalTransmission: boolean;
}

export const DEFAULT_LIVE_CAPTION_STATUS: LiveCaptionStatusPayload = {
  engineLabel: "確認中",
  aiTransmissionLabel: "確認中",
  isExternalTransmission: false,
};

export function isLiveCaptionStatusPayload(
  value: unknown,
): value is LiveCaptionStatusPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LiveCaptionStatusPayload>;
  return (
    typeof candidate.engineLabel === "string" &&
    typeof candidate.aiTransmissionLabel === "string" &&
    typeof candidate.isExternalTransmission === "boolean"
  );
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
      ? parsed
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
