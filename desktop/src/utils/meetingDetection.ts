import type { MeetingAppDetectedPayload } from "../types";

function isMeetingDetectionSource(
  value: unknown,
): value is MeetingAppDetectedPayload["source"] {
  return value === "app" || value === "browser";
}

export function isMeetingAppDetectedPayload(
  value: unknown,
): value is MeetingAppDetectedPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<MeetingAppDetectedPayload>;
  return (
    typeof candidate.bundleId === "string" &&
    typeof candidate.appName === "string" &&
    (candidate.source === undefined ||
      isMeetingDetectionSource(candidate.source)) &&
    (candidate.service === undefined ||
      typeof candidate.service === "string") &&
    (candidate.urlHost === undefined ||
      typeof candidate.urlHost === "string") &&
    (candidate.browserName === undefined ||
      typeof candidate.browserName === "string") &&
    (candidate.windowTitle === undefined ||
      typeof candidate.windowTitle === "string")
  );
}
