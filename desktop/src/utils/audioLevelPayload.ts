import type { AudioLevelPayload } from "../types";

function isAudioLevelSource(value: unknown): value is AudioLevelPayload["source"] {
  return value === "microphone" || value === "system_audio";
}

export function isAudioLevelPayload(value: unknown): value is AudioLevelPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AudioLevelPayload>;
  return (
    isAudioLevelSource(candidate.source) &&
    typeof candidate.level === "number" &&
    Number.isFinite(candidate.level)
  );
}
