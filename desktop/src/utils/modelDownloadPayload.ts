import type { DownloadErrorPayload, DownloadProgressPayload } from "../types";

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
    Number.isFinite(candidate.progress)
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
