import type { TranscriptionEngineType } from "../types";
import { APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON } from "./transcriptionSourceHelpers";

export function getMeetingStartBlockedReason(
  isMeetingActive: boolean,
  isSettingsLoading: boolean,
  settingsError: unknown,
  transcriptionEngine: TranscriptionEngineType | undefined,
  requiresLocalModel: boolean,
  isModelDownloaded: boolean | undefined,
  modelDownloadedError: unknown,
  externalApiProvider: string | null,
  hasExternalApiKey: boolean | undefined,
  externalApiKeyError: unknown,
): string | null {
  if (isMeetingActive) return null;
  if (settingsError) {
    return "文字起こし設定を確認できません。";
  }
  if (isSettingsLoading) {
    return "文字起こし設定を確認中です。";
  }
  if (modelDownloadedError) {
    return "Whisper モデルを確認できません。";
  }
  if (externalApiKeyError && externalApiProvider) {
    return `${externalApiProvider} API キーを確認できません。`;
  }
  if (transcriptionEngine === "appleSpeech") {
    return APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON;
  }
  if (externalApiProvider && hasExternalApiKey === undefined) {
    return `${externalApiProvider} API キーの状態を確認中です。`;
  }
  if (externalApiProvider && !hasExternalApiKey) {
    return `${externalApiProvider} API キーを登録してください。`;
  }
  if (!requiresLocalModel) return null;
  if (isModelDownloaded === undefined) {
    return "記録開始に必要な Whisper モデルの状態を確認中です。";
  }
  if (!isModelDownloaded) {
    return "記録を開始するには、Whisper モデルのダウンロードが必要です。";
  }
  return null;
}
