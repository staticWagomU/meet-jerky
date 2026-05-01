import type { MeetingAppDetectedPayload } from "../types";

function isMeetingDetectionSource(
  value: unknown,
): value is MeetingAppDetectedPayload["source"] {
  return value === "app" || value === "browser";
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    isNonEmptyTrimmedString(candidate.bundleId) &&
    isNonEmptyTrimmedString(candidate.appName) &&
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
    isNonEmptyTrimmedString(candidate.bundleId) &&
    isNonEmptyTrimmedString(candidate.appName) &&
    candidate.source === "browser" &&
    isNonEmptyTrimmedString(candidate.service) &&
    isHostOnlyString(candidate.urlHost) &&
    isNonEmptyTrimmedString(candidate.browserName) &&
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
