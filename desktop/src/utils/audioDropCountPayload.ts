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
    candidate.dropped >= 0 &&
    Number.isSafeInteger(candidate.dropped)
  );
}

export function getAudioDropCountPayloadIssue(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload がオブジェクトではありません";
  }

  const candidate = value as Partial<AudioDropCountPayload>;
  if (!isAudioDropCountSource(candidate.source)) {
    return "source が microphone/system_audio ではありません";
  }

  if (
    typeof candidate.dropped !== "number" ||
    !Number.isFinite(candidate.dropped)
  ) {
    return "dropped が有限数ではありません";
  }

  if (!Number.isInteger(candidate.dropped)) {
    return "dropped が整数ではありません";
  }

  if (candidate.dropped < 0) {
    return "dropped が 0 以上ではありません";
  }

  if (!Number.isSafeInteger(candidate.dropped)) {
    return "dropped が安全整数範囲内ではありません";
  }

  return "形式が不正です";
}
