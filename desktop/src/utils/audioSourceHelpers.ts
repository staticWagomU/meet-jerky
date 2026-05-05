import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "./audioTrackLabels";

export function getAudioSourceStatusLabel(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string {
  if (isMicRecording && isSystemAudioRecording) {
    return "自分と相手側を取得中";
  }
  if (isMicRecording) {
    return "自分のみ録音中";
  }
  if (isSystemAudioRecording) {
    return "相手側のみ取得中";
  }
  return "未取得";
}

export function getAudioSourceStatusAriaText(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string {
  if (isMicRecording && isSystemAudioRecording) {
    return "自分と相手側を取得中";
  }
  if (isMicRecording) {
    return "自分のみ録音中、相手側は未取得";
  }
  if (isSystemAudioRecording) {
    return "相手側のみ取得中、自分は未録音";
  }
  return "自分と相手側とも未取得";
}

export function getAudioSourceNotice(
  isVisible: boolean,
  isAudioCaptureOperationPending: boolean,
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
  systemAudioFormatWarning: string | null,
): string | null {
  if (!isVisible) {
    return null;
  }
  if (systemAudioFormatWarning) {
    return `相手側音声入力の形式に問題があります: ${systemAudioFormatWarning}`;
  }
  if (
    isAudioCaptureOperationPending ||
    (isMicRecording && isSystemAudioRecording)
  ) {
    return null;
  }
  if (isMicRecording) {
    return `${OTHER_TRACK_DEVICE_LABEL}は未取得です。相手側の発話は文字起こしされません。`;
  }
  if (isSystemAudioRecording) {
    return `${SELF_TRACK_DEVICE_LABEL}は未録音です。自分の発話は文字起こしされません。`;
  }
  return `${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}は未取得です。発話は文字起こしされません。`;
}

export function getAudioSourceStatusPillClass(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string {
  if (isMicRecording && isSystemAudioRecording) {
    return "meeting-status-pill-active";
  }
  if (!isMicRecording && !isSystemAudioRecording) {
    return "meeting-status-pill-idle";
  }
  return "meeting-status-pill-neutral";
}
