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

function isFiniteInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  );
}

export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

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
    isFiniteInteger(candidate.startMs) &&
    candidate.startMs >= 0 &&
    isFiniteInteger(candidate.endMs) &&
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

export function getTranscriptionErrorPayloadIssue(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload がオブジェクトではありません";
  }
  const candidate = value as Partial<TranscriptionErrorPayload>;
  if (!isSafeTrimmedString(candidate.error, 4000)) {
    return "error が空、長すぎる、または制御文字を含みます";
  }
  if (
    candidate.source !== undefined &&
    !isTranscriptAudioSource(candidate.source)
  ) {
    return "source が不明です";
  }
  return "形式が不正です";
}
