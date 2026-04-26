export interface AudioDevice {
  name: string;
  id: string;
}

export interface AudioLevelPayload {
  source: "microphone" | "system_audio";
  level: number;
}

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  source?: "microphone" | "system_audio";
  speaker?: string; // "自分" (mic) or "相手" (system audio)
  isError?: boolean;
}

export interface TranscriptionErrorPayload {
  error: string;
  source?: "microphone" | "system_audio";
}

export interface ModelInfo {
  name: string;
  displayName: string;
  sizeMb: number;
  url: string;
}

export interface DownloadProgressPayload {
  progress: number;
  model: string;
}

export interface DownloadErrorPayload {
  model: string;
  message: string;
}

export interface StartSessionArgs {
  title: string;
}

export interface FinalizeSessionResult {
  path: string;
}

export type TranscriptionEngineType =
  | "whisper"
  | "appleSpeech"
  | "openAIRealtime";

export interface AppSettings {
  transcriptionEngine: TranscriptionEngineType;
  whisperModel: string;
  microphoneDeviceId: string | null;
  language: string;
  outputDirectory: string | null;
  apiKey?: string;
}

/// `meeting-app-detected` Tauri イベントの payload。
/// Zoom / Teams 等が起動したときに Rust 側から発火する。
export interface MeetingAppDetectedPayload {
  bundleId: string;
  appName: string;
  source?: string;
  service?: string;
  urlHost?: string;
  browserName?: string;
  windowTitle?: string;
}
