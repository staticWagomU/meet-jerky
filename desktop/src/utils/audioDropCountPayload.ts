import type { AudioDropCountPayload } from "../types";

function isAudioDropCountSource(
  value: unknown,
): value is AudioDropCountPayload["source"] {
  return value === "microphone" || value === "system_audio";
}

export function isAudioDropCountPayload(
  value: unknown,
): value is AudioDropCountPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AudioDropCountPayload>;
  return (
    isAudioDropCountSource(candidate.source) &&
    typeof candidate.dropped === "number" &&
    Number.isFinite(candidate.dropped) &&
    Number.isInteger(candidate.dropped) &&
    candidate.dropped >= 0
  );
}
