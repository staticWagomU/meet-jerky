import type { TranscriptSegment } from "../types";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "./audioTrackLabels";
import { isTranscriptErrorSegment } from "./transcriptSegment";
import { formatSegmentTimestamp } from "./timeFormat";

export function getSpeakerKind(
  segment: TranscriptSegment,
): "self" | "other" | null {
  if (segment.source === "microphone") return "self";
  if (segment.source === "system_audio") return "other";
  if (segment.speaker === "自分") return "self";
  if (segment.speaker) return "other";
  return null;
}

export function getSpeakerLabel(segment: TranscriptSegment): string | null {
  if (segment.source === "microphone") return "自分";
  if (segment.source === "system_audio") return "相手側";
  if (segment.speaker) return segment.speaker;
  return "ソース不明";
}

export function getSpeakerAriaLabel(segment: TranscriptSegment): string {
  if (segment.source === "microphone") return SELF_TRACK_DEVICE_LABEL;
  if (segment.source === "system_audio") {
    return OTHER_TRACK_DEVICE_LABEL;
  }
  if (segment.speaker === "自分") return "自分トラック";
  if (segment.speaker) return `話者 ${segment.speaker}`;
  return "音声ソース不明";
}

export function isSourceLessError(segment: TranscriptSegment): boolean {
  return Boolean(
    isTranscriptErrorSegment(segment) && !segment.speaker && !segment.source,
  );
}

export function getSegmentAriaLabel(segment: TranscriptSegment): string {
  const speakerLabel = isSourceLessError(segment)
    ? "音声ソース不明"
    : getSpeakerAriaLabel(segment);
  if (isTranscriptErrorSegment(segment)) {
    return `文字起こしエラー ${speakerLabel}: ${segment.text}`;
  }
  return `文字起こし ${formatSegmentTimestamp(segment.startMs)} ${speakerLabel}: ${segment.text}`;
}

export function getVisibleSpeakerLabel(
  segment: TranscriptSegment,
): string | null {
  if (isSourceLessError(segment)) {
    return "ソース不明";
  }
  return getSpeakerLabel(segment);
}

export function getSegmentCounts(segments: TranscriptSegment[]): {
  self: number;
  other: number;
  unknown: number;
  errors: number;
  copyable: number;
} {
  return segments.reduce(
    (counts, segment) => {
      if (isTranscriptErrorSegment(segment)) {
        counts.errors += 1;
        return counts;
      }
      counts.copyable += 1;
      const speakerKind = getSpeakerKind(segment);
      if (speakerKind === "self") {
        counts.self += 1;
      } else if (speakerKind === "other") {
        counts.other += 1;
      } else {
        counts.unknown += 1;
      }
      return counts;
    },
    { self: 0, other: 0, unknown: 0, errors: 0, copyable: 0 },
  );
}
