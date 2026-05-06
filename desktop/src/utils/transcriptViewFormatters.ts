import { toErrorMessage } from "./errorMessage";

export const SESSION_DATETIME_UNKNOWN_LABEL = "日時不明";

export function formatOperationError(prefix: string, e: unknown): string {
  return `${prefix} ${toErrorMessage(e)}`;
}

export function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function getCompactSessionTitle(title: string): string {
  const displayTitle = title
    .replace(/\s-\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/, "")
    .trim();
  return displayTitle || "無題の会議";
}

export function getRecentSessionMeta(startedAtSecs: number): string {
  const startedAtMs = startedAtSecs * 1000;
  if (!Number.isFinite(startedAtMs)) {
    return SESSION_DATETIME_UNKNOWN_LABEL;
  }
  const startedAtDate = new Date(startedAtMs);
  if (Number.isNaN(startedAtDate.getTime())) {
    return SESSION_DATETIME_UNKNOWN_LABEL;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(startedAtDate);
}

/** 経過時間をフォーマットする */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
