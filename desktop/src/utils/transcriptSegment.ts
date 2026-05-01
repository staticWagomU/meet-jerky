import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";

const REALTIME_ERROR_PREFIXES = [
  "[OpenAI Realtime エラー:",
  "[ElevenLabs Realtime エラー:",
];

export function isTranscriptErrorSegment(
  segment: TranscriptSegment | null | undefined,
): boolean {
  if (!segment) {
    return false;
  }
  return (
    Boolean(segment.isError) ||
    REALTIME_ERROR_PREFIXES.some((prefix) => segment.text.startsWith(prefix))
  );
}

function isTranscriptAudioSource(
  value: unknown,
): value is TranscriptSegment["source"] {
  return value === "microphone" || value === "system_audio";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

function isSafeTrimmedString(
  value: unknown,
  maxTrimmedLength: number,
): value is string {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxTrimmedLength;
}

export function isTranscriptSegmentPayload(
  value: unknown,
): value is TranscriptSegment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TranscriptSegment>;
  return (
    isSafeTrimmedString(candidate.text, 4000) &&
    isFiniteNumber(candidate.startMs) &&
    candidate.startMs >= 0 &&
    isFiniteNumber(candidate.endMs) &&
    candidate.endMs >= candidate.startMs &&
    (candidate.source === undefined ||
      isTranscriptAudioSource(candidate.source)) &&
    (candidate.speaker === undefined ||
      isSafeTrimmedString(candidate.speaker, 80)) &&
    (candidate.isError === undefined || typeof candidate.isError === "boolean")
  );
}

export function isTranscriptionErrorPayload(
  value: unknown,
): value is TranscriptionErrorPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TranscriptionErrorPayload>;
  return (
    isSafeTrimmedString(candidate.error, 4000) &&
    (candidate.source === undefined || isTranscriptAudioSource(candidate.source))
  );
}
