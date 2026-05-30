import type { ModelInfo } from "../types";

const WHISPER_MODEL_LABELS: Record<string, string> = {
  tiny: "Tiny（最軽量）",
  base: "Base（標準）",
  small: "Small（軽量高精度）",
  medium: "Medium（高精度）",
  "large-v3": "Large v3（最高精度）",
};

export function sanitizeProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.max(0, Math.min(1, progress));
}

export function getWhisperModelLabel(
  model: Pick<ModelInfo, "name" | "displayName">,
): string {
  return WHISPER_MODEL_LABELS[model.name] ?? model.displayName;
}

export function getModelDisplayName(
  models: ModelInfo[] | undefined,
  modelName: string | null,
): string | null {
  if (!modelName) {
    return null;
  }
  const model = models?.find((item) => item.name === modelName);
  return model
    ? getWhisperModelLabel(model)
    : (WHISPER_MODEL_LABELS[modelName] ?? modelName);
}
