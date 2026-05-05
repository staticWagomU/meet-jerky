import type { TranscriptSegment } from "../types";
import { isTranscriptErrorSegment } from "./transcriptSegment";
import { formatSegmentTimestamp } from "./timeFormat";
import type { LiveCaptionStatusPayload } from "./liveCaptionStatus";

type AudioSource = NonNullable<TranscriptSegment["source"]>;

export type LatestBySource = Record<AudioSource, TranscriptSegment | null>;

export type TrackCaptureState = "active" | "switching" | "inactive";

export function createEmptyLatestBySource(): LatestBySource {
  return {
    microphone: null,
    system_audio: null,
  };
}

export function getSpeakerLabel(segment: TranscriptSegment): string {
  if (segment.source === "microphone") return "自分";
  if (segment.source === "system_audio") return "相手側";
  return segment.speaker || "ソース不明";
}

export function getSpeakerClassName(segment: TranscriptSegment): string {
  if (segment.source === "microphone") {
    return "live-transcript-speaker live-transcript-speaker-self";
  }
  if (segment.source === "system_audio") {
    return "live-transcript-speaker live-transcript-speaker-other";
  }
  return "live-transcript-speaker live-transcript-speaker-unknown";
}

export function getTrackStateLabel(
  segment: TranscriptSegment | null,
  captureLabel: string,
): string {
  if (!segment) {
    return captureLabel;
  }
  if (isTranscriptErrorSegment(segment)) {
    return `${captureLabel}・エラー`;
  }
  return `${captureLabel}・${formatSegmentTimestamp(segment.startMs)}`;
}

export function getTrackCaptureState(label: string): TrackCaptureState {
  const normalizedLabel = label.trim();
  if (normalizedLabel.includes("切替中")) {
    return "switching";
  }
  if (
    normalizedLabel.includes("録音中") ||
    normalizedLabel.includes("取得中")
  ) {
    return "active";
  }
  return "inactive";
}

export function getVisibleTrackSummary(status: LiveCaptionStatusPayload): string {
  const microphoneState = getTrackCaptureState(status.microphoneTrackLabel);
  const systemAudioState = getTrackCaptureState(status.systemAudioTrackLabel);

  if (microphoneState === "switching" || systemAudioState === "switching") {
    return "切替中";
  }
  if (microphoneState === "active" && systemAudioState === "active") {
    return "Mic + System";
  }
  if (microphoneState === "active") {
    return "Mic only";
  }
  if (systemAudioState === "active") {
    return "System only";
  }
  return "未取得";
}
