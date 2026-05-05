import type { TranscriptionEngineType } from "../types";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "./audioTrackLabels";

export const APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON =
  "Apple Speech は現在、自分トラックと相手側トラックの同時文字起こしを安全に開始できません。どちらか片方だけで開始するか、Whisper / OpenAI Realtime / ElevenLabs Realtime を選択してください。";

export function getTranscriptionSourceStatus(
  isTranscribing: boolean,
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string | null {
  if (!isTranscribing) {
    if (isMicRecording && isSystemAudioRecording) {
      return "文字起こし待機: 自分と相手側";
    }
    if (isMicRecording) {
      return "文字起こし待機: 自分のみ、相手側は未取得";
    }
    if (isSystemAudioRecording) {
      return "文字起こし待機: 相手側のみ、自分は未録音";
    }
    return null;
  }
  if (isMicRecording && isSystemAudioRecording) {
    return "文字起こし中: 自分と相手側";
  }
  if (isMicRecording) {
    return "文字起こし中: 自分のみ、相手側は未取得";
  }
  if (isSystemAudioRecording) {
    return "文字起こし中: 相手側のみ、自分は未録音";
  }
  return "文字起こし中: 自分と相手側とも未取得";
}

export function getTranscriptionSourceStatusAriaText(
  isTranscribing: boolean,
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string | null {
  if (!isTranscribing) {
    if (isMicRecording && isSystemAudioRecording) {
      return `文字起こし待機: ${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}`;
    }
    if (isMicRecording) {
      return `文字起こし待機: ${SELF_TRACK_DEVICE_LABEL}のみ、${OTHER_TRACK_DEVICE_LABEL}は未取得`;
    }
    if (isSystemAudioRecording) {
      return `文字起こし待機: ${OTHER_TRACK_DEVICE_LABEL}のみ、${SELF_TRACK_DEVICE_LABEL}は未録音`;
    }
    return null;
  }
  if (isMicRecording && isSystemAudioRecording) {
    return `文字起こし中: ${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}`;
  }
  if (isMicRecording) {
    return `文字起こし中: ${SELF_TRACK_DEVICE_LABEL}のみ、${OTHER_TRACK_DEVICE_LABEL}は未取得`;
  }
  if (isSystemAudioRecording) {
    return `文字起こし中: ${OTHER_TRACK_DEVICE_LABEL}のみ、${SELF_TRACK_DEVICE_LABEL}は未録音`;
  }
  return `文字起こし中: ${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}とも未取得`;
}

export function getTranscriptionSourceArg(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): "microphone" | "system_audio" | "both" | null {
  if (isMicRecording && isSystemAudioRecording) return "both";
  if (isMicRecording) return "microphone";
  if (isSystemAudioRecording) return "system_audio";
  return null;
}

export function getTranscriptionStartBlockedReason(
  isTranscribing: boolean,
  isSettingsLoading: boolean,
  settingsError: unknown,
  isAnySourceRecording: boolean,
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
  transcriptionEngine: TranscriptionEngineType | undefined,
  requiresLocalModel: boolean,
  isModelDownloaded: boolean | undefined,
  modelDownloadedError: unknown,
  externalApiProvider: string | null,
  hasExternalApiKey: boolean | undefined,
  externalApiKeyError: unknown,
): string | null {
  if (isTranscribing) return null;
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
  if (!isAnySourceRecording) {
    return `文字起こしを開始するには、${SELF_TRACK_DEVICE_LABEL}の録音または${OTHER_TRACK_DEVICE_LABEL}の取得を開始してください。`;
  }
  if (
    transcriptionEngine === "appleSpeech" &&
    isMicRecording &&
    isSystemAudioRecording
  ) {
    return APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON;
  }
  if (externalApiProvider && hasExternalApiKey === undefined) {
    return `${externalApiProvider} API キーの状態を確認中です。`;
  }
  if (externalApiProvider && !hasExternalApiKey) {
    return `${externalApiProvider} Realtime の利用には、設定画面で API キーを登録してください。`;
  }
  if (!requiresLocalModel) {
    return null;
  }
  if (isModelDownloaded === undefined) {
    return "Whisper モデルの状態を確認中です。";
  }
  if (!isModelDownloaded) {
    return "文字起こしを開始するには、Whisper モデルのダウンロードが必要です。";
  }
  return null;
}
