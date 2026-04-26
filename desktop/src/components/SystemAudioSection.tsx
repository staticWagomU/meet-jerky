import {
  AudioLevelMeter,
  sanitizeAudioLevelForDisplay,
} from "./AudioLevelMeter";

interface SystemAudioSectionProps {
  isSystemAudioRecording: boolean;
  systemAudioLevel: number;
  isOperationPending: boolean;
  onToggleSystemAudio: () => void;
}

export function SystemAudioSection({
  isSystemAudioRecording,
  systemAudioLevel,
  isOperationPending,
  onToggleSystemAudio,
}: SystemAudioSectionProps) {
  const systemAudioLevelPercent = Math.round(
    sanitizeAudioLevelForDisplay(systemAudioLevel) * 100,
  );

  return (
    <div className="audio-source-section">
      <div className="audio-source-header">
        <span>システム音声</span>
        <span className="audio-source-track-badge">相手側</span>
        <span
          className={`audio-source-state-badge ${
            isSystemAudioRecording
              ? "audio-source-state-badge-active"
              : "audio-source-state-badge-idle"
          }`}
        >
          {isSystemAudioRecording ? "取得中" : "待機中"}
        </span>
      </div>
      <div className="controls-row">
        <button
          type="button"
          onClick={onToggleSystemAudio}
          disabled={isOperationPending}
          className={`control-btn ${isSystemAudioRecording ? "control-btn-stop" : "control-btn-capture"}`}
        >
          <span
            className={`rec-indicator ${isSystemAudioRecording ? "rec-indicator-active" : ""}`}
          />
          {isOperationPending
            ? "処理中..."
            : isSystemAudioRecording
              ? "キャプチャ停止"
              : "キャプチャ開始"}
        </button>
      </div>
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter level={systemAudioLevel} />
        </div>
        <span className="level-label">{systemAudioLevelPercent}%</span>
      </div>
      <div className="system-audio-note">
        macOSの画面収録の許可が必要です
      </div>
    </div>
  );
}
