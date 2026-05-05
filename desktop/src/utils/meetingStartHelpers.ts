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
    return "文字起こし設定を取得できません。設定画面または再読み込みで状態を確認してください。";
  }
  if (isSettingsLoading) {
    return "文字起こし設定を確認中です。";
  }
  if (modelDownloadedError) {
    return "Whisper モデルの状態を確認できません。設定画面でモデル状態を確認してください。";
  }
  if (externalApiKeyError && externalApiProvider) {
    return `${externalApiProvider} API キーの状態を確認できません。設定画面で API キー状態を再確認してください。`;
  }
  if (transcriptionEngine === "appleSpeech") {
    return APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON;
  }
  if (externalApiProvider && hasExternalApiKey === undefined) {
    return `${externalApiProvider} API キーの状態を確認中です。`;
  }
  if (externalApiProvider && !hasExternalApiKey) {
    return `記録を開始するには、${externalApiProvider} Realtime の API キーを設定画面で登録してください。`;
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
