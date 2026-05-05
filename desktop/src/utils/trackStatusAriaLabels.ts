import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "./audioTrackLabels";

export function getMicTrackStatusAriaLabel(statusLabel: string): string {
  return `${SELF_TRACK_DEVICE_LABEL}: ${statusLabel}`;
}

export function getSystemAudioTrackStatusAriaLabel(statusLabel: string): string {
  return `${OTHER_TRACK_DEVICE_LABEL}: ${statusLabel}`;
}
