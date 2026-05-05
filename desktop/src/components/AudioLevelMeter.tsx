import { getLevelColor, sanitizeAudioLevel } from '../utils/audioLevelHelpers';

interface AudioLevelMeterProps {
  level: number;
  label: string;
}

export function AudioLevelMeter({ level, label }: AudioLevelMeterProps) {
  const clampedLevel = sanitizeAudioLevel(level);
  const percentage = clampedLevel * 100;
  const roundedPercentage = Math.round(percentage);
  const color = getLevelColor(clampedLevel);

  return (
    <div
      className="audio-meter-container"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={roundedPercentage}
      aria-valuetext={`${roundedPercentage}%`}
      title={`${label}: ${roundedPercentage}%`}
    >
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
