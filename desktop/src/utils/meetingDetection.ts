import type { MeetingAppDetectedPayload } from "../types";

export const MEETING_APP_DETECTED_EVENT = "meeting-app-detected";

const MAX_MEETING_DETECTION_BUNDLE_ID_LENGTH = 256;
const MAX_MEETING_DETECTION_DISPLAY_STRING_LENGTH = 120;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

function isMeetingDetectionSource(
  value: unknown,
): value is MeetingAppDetectedPayload["source"] {
  return value === "app" || value === "browser";
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedDisplayString(
  value: unknown,
  maxTrimmedLength: number,
): value is string {
  if (!isNonEmptyTrimmedString(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  return value.trim().length <= maxTrimmedLength;
}

const disallowedUrlHostCharacters = /[\s/?#@:]/u;
const dnsHostLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

function isHostOnlyString(value: unknown): value is string {
  if (
    !isNonEmptyTrimmedString(value) ||
    disallowedUrlHostCharacters.test(value)
  ) {
    return false;
  }
  const host = value.trim();
  if (host.length > 253 || host.startsWith(".") || host.endsWith(".")) {
    return false;
  }
  return host.split(".").every((label) => dnsHostLabel.test(label));
}

function isHostOnlyStringOrEmpty(value: unknown): value is string {
  return value === "" || isHostOnlyString(value);
}

function hasProperty(value: Record<string, unknown>, key: string): boolean {
  return key in value;
}

function hasDisallowedPrivacyField(candidate: Record<string, unknown>): boolean {
  return (
    hasProperty(candidate, "url") ||
    hasProperty(candidate, "fullUrl") ||
    hasProperty(candidate, "windowTitle")
  );
}

function isMeetingAppDetectedAppPayload(
  candidate: Record<string, unknown>,
): boolean {
  return (
    isBoundedDisplayString(
      candidate.bundleId,
      MAX_MEETING_DETECTION_BUNDLE_ID_LENGTH,
    ) &&
    isBoundedDisplayString(
      candidate.appName,
      MAX_MEETING_DETECTION_DISPLAY_STRING_LENGTH,
    ) &&
    candidate.source === "app" &&
    !hasProperty(candidate, "service") &&
    !hasProperty(candidate, "urlHost") &&
    !hasProperty(candidate, "browserName") &&
    !hasDisallowedPrivacyField(candidate)
  );
}

function isMeetingAppDetectedBrowserPayload(
  candidate: Record<string, unknown>,
): boolean {
  return (
    isBoundedDisplayString(
      candidate.bundleId,
      MAX_MEETING_DETECTION_BUNDLE_ID_LENGTH,
    ) &&
    isBoundedDisplayString(
      candidate.appName,
      MAX_MEETING_DETECTION_DISPLAY_STRING_LENGTH,
    ) &&
    candidate.source === "browser" &&
    isBoundedDisplayString(
      candidate.service,
      MAX_MEETING_DETECTION_DISPLAY_STRING_LENGTH,
    ) &&
    isHostOnlyStringOrEmpty(candidate.urlHost) &&
    isBoundedDisplayString(
      candidate.browserName,
      MAX_MEETING_DETECTION_DISPLAY_STRING_LENGTH,
    ) &&
    !hasDisallowedPrivacyField(candidate)
  );
}

export function isMeetingAppDetectedPayload(
  value: unknown,
): value is MeetingAppDetectedPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isMeetingDetectionSource(candidate.source)) {
    return false;
  }
  if (candidate.source === "app") {
    return isMeetingAppDetectedAppPayload(candidate);
  }
  return isMeetingAppDetectedBrowserPayload(candidate);
}
