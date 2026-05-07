import type { DownloadErrorPayload, DownloadProgressPayload } from "../types";

export const MODEL_DOWNLOAD_PROGRESS_EVENT = "model-download-progress";
export const MODEL_DOWNLOAD_ERROR_EVENT = "model-download-error";

const MODEL_NAME_MAX_LENGTH = 80;
const DOWNLOAD_ERROR_MESSAGE_MAX_LENGTH = 4000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

function isBoundedDisplayString(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmedValue = value.trim();
  return (
    trimmedValue.length > 0 &&
    trimmedValue.length <= maxLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

export function isDownloadProgressPayload(
  value: unknown,
): value is DownloadProgressPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DownloadProgressPayload>;
  return (
    isBoundedDisplayString(candidate.model, MODEL_NAME_MAX_LENGTH) &&
    typeof candidate.progress === "number" &&
    Number.isFinite(candidate.progress) &&
    candidate.progress >= 0 &&
    candidate.progress <= 1
  );
}

export function getDownloadProgressPayloadIssue(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload がオブジェクトではありません";
  }
  const candidate = value as Partial<DownloadProgressPayload>;
  if (!isBoundedDisplayString(candidate.model, MODEL_NAME_MAX_LENGTH)) {
    return "model が安全な表示文字列ではありません";
  }
  if (
    typeof candidate.progress !== "number" ||
    !Number.isFinite(candidate.progress)
  ) {
    return "progress が有限数ではありません";
  }
  if (candidate.progress < 0 || candidate.progress > 1) {
    return "progress が 0 以上 1 以下ではありません";
  }
  return "形式が不正です";
}

export function isDownloadErrorPayload(
  value: unknown,
): value is DownloadErrorPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DownloadErrorPayload>;
  return (
    isBoundedDisplayString(candidate.model, MODEL_NAME_MAX_LENGTH) &&
    isBoundedDisplayString(
      candidate.message,
      DOWNLOAD_ERROR_MESSAGE_MAX_LENGTH,
    )
  );
}

export function getDownloadErrorPayloadIssue(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload がオブジェクトではありません";
  }
  const candidate = value as Partial<DownloadErrorPayload>;
  if (!isBoundedDisplayString(candidate.model, MODEL_NAME_MAX_LENGTH)) {
    return "model が安全な表示文字列ではありません";
  }
  if (
    !isBoundedDisplayString(
      candidate.message,
      DOWNLOAD_ERROR_MESSAGE_MAX_LENGTH,
    )
  ) {
    return "message が安全な表示文字列ではありません";
  }
  return "形式が不正です";
}
