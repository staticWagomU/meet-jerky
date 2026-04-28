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
