import type { MeetingAppDetectedPayload } from "../types";

export function getMeetingDetectedDisplayName(
  payload: MeetingAppDetectedPayload,
): string {
  return payload.service || payload.appName;
}

export function getMeetingDetectedSourceLabel(
  payload: MeetingAppDetectedPayload,
): string | null {
  const hostLabel = getMeetingDetectedHostLabel(payload.urlHost);
  if (payload.browserName && hostLabel) {
    return `${payload.browserName} URL`;
  }
  if (hostLabel) {
    return "ブラウザ URL";
  }
  if (payload.source === "browser") {
    return "ブラウザ URL";
  }
  if (payload.source === "app") {
    return "アプリ";
  }
  return null;
}

function getMeetingDetectedHostLabel(urlHost: string | undefined): string | null {
  if (!urlHost) {
    return null;
  }
  const trimmed = urlHost.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return (
      trimmed
        .split(/[/?#]/, 1)[0]
        .split("@")
        .pop()
        ?.replace(/:\d+$/, "") || null
    );
  }
}

export function getMeetingDetectedBannerDetail(
  payload: MeetingAppDetectedPayload,
  displayName: string,
): string {
  if (payload.source === "browser") {
    return `${displayName} · URL と音声アクティビティで確認`;
  }
  return `${displayName} · アプリ名と音声アクティビティで確認`;
}
