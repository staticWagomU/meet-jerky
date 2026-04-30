import type { MeetingAppDetectedPayload } from "../types";

function isMeetingDetectionSource(
  value: unknown,
): value is MeetingAppDetectedPayload["source"] {
  return value === "app" || value === "browser";
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isMeetingAppDetectedPayload(
  value: unknown,
): value is MeetingAppDetectedPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<MeetingAppDetectedPayload>;
  return (
    isNonEmptyTrimmedString(candidate.bundleId) &&
    isNonEmptyTrimmedString(candidate.appName) &&
    (candidate.source === undefined ||
      isMeetingDetectionSource(candidate.source)) &&
    (candidate.service === undefined ||
      isNonEmptyTrimmedString(candidate.service)) &&
    (candidate.urlHost === undefined ||
      isNonEmptyTrimmedString(candidate.urlHost)) &&
    (candidate.browserName === undefined ||
      isNonEmptyTrimmedString(candidate.browserName)) &&
    (candidate.windowTitle === undefined ||
      isNonEmptyTrimmedString(candidate.windowTitle))
  );
}
