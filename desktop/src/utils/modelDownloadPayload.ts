import type { DownloadErrorPayload, DownloadProgressPayload } from "../types";

export const MODEL_DOWNLOAD_PROGRESS_EVENT = "model-download-progress";
export const MODEL_DOWNLOAD_ERROR_EVENT = "model-download-error";

export function isDownloadProgressPayload(
  value: unknown,
): value is DownloadProgressPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DownloadProgressPayload>;
  return (
    typeof candidate.model === "string" &&
    typeof candidate.progress === "number" &&
    Number.isFinite(candidate.progress) &&
    candidate.progress >= 0 &&
    candidate.progress <= 1
  );
}

export function isDownloadErrorPayload(
  value: unknown,
): value is DownloadErrorPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DownloadErrorPayload>;
  return (
    typeof candidate.model === "string" &&
    typeof candidate.message === "string"
  );
}
