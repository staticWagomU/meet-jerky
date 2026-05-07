import { CONTROL_CHARACTER_PATTERN } from "./transcriptSegment";

const MAX_SYSTEM_AUDIO_FORMAT_WARNING_LENGTH = 400;

export const SYSTEM_AUDIO_FORMAT_WARNING_INVALID_MESSAGE =
  "音声形式警告通知の形式が不正です。";
export const SYSTEM_AUDIO_FORMAT_WARNING_EMPTY_MESSAGE =
  "相手側音声入力の形式を確認できません。";

export function normalizeSystemAudioFormatWarningPayload(
  value: unknown,
): string {
  if (typeof value !== "string") {
    return SYSTEM_AUDIO_FORMAT_WARNING_INVALID_MESSAGE;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return SYSTEM_AUDIO_FORMAT_WARNING_INVALID_MESSAGE;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return SYSTEM_AUDIO_FORMAT_WARNING_EMPTY_MESSAGE;
  }
  if (trimmed.length > MAX_SYSTEM_AUDIO_FORMAT_WARNING_LENGTH) {
    return SYSTEM_AUDIO_FORMAT_WARNING_INVALID_MESSAGE;
  }
  return trimmed;
}
