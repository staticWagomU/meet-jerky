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
    const ratio = level / 0.5;
    const r = Math.round(76 + (234 - 76) * ratio);
    const g = Math.round(175 + (179 - 175) * ratio);
    const b = Math.round(80 + (8 - 80) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const ratio = (level - 0.5) / 0.5;
  const r = Math.round(234 + (220 - 234) * ratio);
  const g = Math.round(179 + (38 - 179) * ratio);
  const b = Math.round(8 + (38 - 8) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}
