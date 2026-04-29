import {
  OTHER_TRACK_PERMISSION_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "./audioTrackLabels";

export const MACOS_MICROPHONE_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export const MACOS_SCREEN_RECORDING_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export const MACOS_ACCESSIBILITY_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export const OPEN_MICROPHONE_PRIVACY_LABEL =
  `macOS のプライバシーとセキュリティでマイク権限を開く: ${SELF_TRACK_DEVICE_LABEL}`;

export const OPEN_SCREEN_RECORDING_PRIVACY_LABEL =
  `macOS のプライバシーとセキュリティで画面収録権限を開く: ${OTHER_TRACK_PERMISSION_LABEL}`;

export const OPEN_ACCESSIBILITY_PRIVACY_LABEL =
  "macOS のプライバシーとセキュリティでアクセシビリティ権限を開く";
