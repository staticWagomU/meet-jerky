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

export function isTranscriptSegmentPayload(
  value: unknown,
): value is TranscriptSegment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TranscriptSegment>;
  return (
    typeof candidate.text === "string" &&
    isFiniteNumber(candidate.startMs) &&
    isFiniteNumber(candidate.endMs) &&
    (candidate.source === undefined ||
      isTranscriptAudioSource(candidate.source)) &&
    (candidate.speaker === undefined || typeof candidate.speaker === "string") &&
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
    typeof candidate.error === "string" &&
    (candidate.source === undefined || isTranscriptAudioSource(candidate.source))
  );
}
