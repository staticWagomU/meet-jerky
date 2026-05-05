export function sanitizeAudioLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.max(0, Math.min(1, level));
}

export function getPopoverLevelBars(level: number): [number, number, number] {
  const normalized = sanitizeAudioLevel(level);
  return [
    Math.max(0.45, normalized * 0.9),
    Math.max(0.32, normalized * 0.65),
    Math.max(0.5, normalized * 0.78),
  ];
}
