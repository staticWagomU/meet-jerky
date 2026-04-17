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
  speaker?: string; // "自分" (mic) or "相手" (system audio)
  isError?: boolean;
}

export interface TranscriptionErrorPayload {
  error: string;
}

export interface ModelInfo {
  name: string;
  displayName: string;
  sizeMb: number;
  url: string;
}

export interface DownloadProgressPayload {
  progress: number;
}
