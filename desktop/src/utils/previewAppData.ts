import type {
  AppSettings,
  AudioDevice,
  ModelInfo,
  TranscriptSegment,
} from "../types";
import {
  LOCAL_AUDIO_TRANSMISSION_LABEL,
  type LiveCaptionStatusPayload,
} from "./liveCaptionStatus";

export const PREVIEW_AUDIO_DEVICES: AudioDevice[] = [
  { id: "preview-built-in-mic", name: "MacBook Pro Microphone" },
  { id: "preview-studio-display", name: "Studio Display Microphone" },
];

export const PREVIEW_APP_SETTINGS: AppSettings = {
  transcriptionEngine: "whisper",
  whisperModel: "small",
  microphoneDeviceId: PREVIEW_AUDIO_DEVICES[0].id,
  language: "auto",
  outputDirectory: "/Users/wagomu/MeetJerky",
  aiMinutesProvider: "none",
  detectionRules: {
    enabled: true,
    minimumSignalCount: 2,
    requireAudioSignal: false,
    enabledServices: ["googleMeet", "zoom", "teams", "faceTime", "browserUrls"],
  },
};

export const PREVIEW_MODELS: ModelInfo[] = [
  {
    name: "tiny",
    displayName: "Tiny（最軽量）",
    sizeMb: 75,
    url: "browser-preview://models/tiny",
  },
  {
    name: "base",
    displayName: "Base（標準）",
    sizeMb: 142,
    url: "browser-preview://models/base",
  },
  {
    name: "small",
    displayName: "Small（軽量高精度）",
    sizeMb: 466,
    url: "browser-preview://models/small",
  },
  {
    name: "medium",
    displayName: "Medium（高精度）",
    sizeMb: 1500,
    url: "browser-preview://models/medium",
  },
  {
    name: "large-v3",
    displayName: "Large v3（最高精度）",
    sizeMb: 3100,
    url: "browser-preview://models/large-v3",
  },
];

export const PREVIEW_TRANSCRIPT_SEGMENTS: TranscriptSegment[] = [
  {
    text: "検知通知とメニューバーのどちらからでも、明示操作で録音を開始できます。",
    startMs: 8000,
    endMs: 14200,
    source: "microphone",
    speaker: "自分",
  },
  {
    text: "録音中は REC 表示、ライブ文字起こし、AI外部送信なしの状態が常に見えると安心です。",
    startMs: 24000,
    endMs: 30200,
    source: "system_audio",
    speaker: "相手側",
  },
];

export const PREVIEW_LIVE_CAPTION_STATUS: LiveCaptionStatusPayload = {
  engineLabel: "Whisper",
  aiTransmissionLabel: LOCAL_AUDIO_TRANSMISSION_LABEL,
  isExternalTransmission: false,
  transcriptionStatusLabel: "文字起こし中",
  microphoneTrackLabel: "録音中",
  systemAudioTrackLabel: "録音中",
};

export function isPreviewModelDownloaded(modelName: string): boolean {
  return modelName === PREVIEW_APP_SETTINGS.whisperModel;
}
