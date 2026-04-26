interface AudioLevelMeterProps {
  level: number;
}

function getLevelColor(level: number): string {
  if (level < 0.5) {
    // green → yellow
    const ratio = level / 0.5;
    const r = Math.round(76 + (234 - 76) * ratio);
    const g = Math.round(175 + (179 - 175) * ratio);
    const b = Math.round(80 + (8 - 80) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  }
  // yellow → red
  const ratio = (level - 0.5) / 0.5;
  const r = Math.round(234 + (220 - 234) * ratio);
  const g = Math.round(179 + (38 - 179) * ratio);
  const b = Math.round(8 + (38 - 8) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

export function sanitizeAudioLevelForDisplay(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.max(0, Math.min(1, level));
}

export function AudioLevelMeter({ level }: AudioLevelMeterProps) {
  const clampedLevel = sanitizeAudioLevelForDisplay(level);
  const percentage = clampedLevel * 100;
  const color = getLevelColor(clampedLevel);

  return (
    <div className="audio-meter-container">
      <div
        className="audio-meter-fill"
        style={{
          width: `${percentage}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}
