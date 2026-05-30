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

export function getLevelColor(level: number): string {
  if (level < 0.5) {
    const greenRatio = Math.round((1 - level / 0.5) * 100);
    return `color-mix(in srgb, var(--es-green) ${greenRatio}%, var(--es-amber))`;
  }
  const amberRatio = Math.round((1 - (level - 0.5) / 0.5) * 100);
  return `color-mix(in srgb, var(--es-amber) ${amberRatio}%, var(--es-red))`;
}
