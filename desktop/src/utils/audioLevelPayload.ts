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
    Number.isFinite(candidate.level) &&
    candidate.level >= 0 &&
    candidate.level <= 1
  );
}

export function getAudioLevelPayloadIssue(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload がオブジェクトではありません";
  }

  const candidate = value as Partial<AudioLevelPayload>;
  if (!isAudioLevelSource(candidate.source)) {
    return "source が microphone/system_audio ではありません";
  }

  if (
    typeof candidate.level !== "number" ||
    !Number.isFinite(candidate.level)
  ) {
    return "level が有限数ではありません";
  }

  if (candidate.level < 0 || candidate.level > 1) {
    return "level が 0 以上 1 以下ではありません";
  }

  return "形式が不正です";
}
