import { AudioLevelMeter } from "./AudioLevelMeter";

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
  return (
    <div className="audio-source-section">
      <div className="audio-source-header">システム音声</div>
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
        <span className="level-label">
          {Math.round(systemAudioLevel * 100)}%
        </span>
      </div>
      <div className="system-audio-note">
        macOSの画面収録の許可が必要です
      </div>
    </div>
  );
}
