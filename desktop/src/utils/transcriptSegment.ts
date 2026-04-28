import type { TranscriptSegment } from "../types";

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
