import type { ModelInfo } from "../types";

export function sanitizeProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.max(0, Math.min(1, progress));
}

export function getModelDisplayName(
  models: ModelInfo[] | undefined,
  modelName: string | null,
): string | null {
  if (!modelName) {
    return null;
  }
  return models?.find((model) => model.name === modelName)?.displayName ?? modelName;
}
