import type { TranscriptionEngineType } from "../types";

export function getRequiresLocalModel(
  engine: TranscriptionEngineType | undefined,
): boolean {
  return !engine || engine === "whisper";
}

export function getExternalApiProvider(
  engine: TranscriptionEngineType | undefined,
): "OpenAI" | "ElevenLabs" | null {
  if (engine === "openAIRealtime") {
    return "OpenAI";
  }
  if (engine === "elevenLabsRealtime") {
    return "ElevenLabs";
  }
  return null;
}
