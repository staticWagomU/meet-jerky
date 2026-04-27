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
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`システム音声 相手側トラック: ${isSystemAudioRecording ? "取得中" : "待機中"}`}
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
          aria-label={
            isOperationPending
              ? "相手側トラックのシステム音声キャプチャを処理中"
              : isSystemAudioRecording
                ? "相手側トラックのシステム音声キャプチャを停止"
                : "相手側トラックのシステム音声キャプチャを開始"
          }
        >
          <span
            className={`rec-indicator ${isSystemAudioRecording ? "rec-indicator-active" : ""}`}
            aria-hidden="true"
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
          <AudioLevelMeter
            level={systemAudioLevel}
            label="システム音声 相手側トラック音量レベル"
          />
        </div>
        <span className="level-label">{systemAudioLevelPercent}%</span>
      </div>
      <div className="audio-source-note">
        相手側音声の取得にはmacOSの画面収録許可が必要です
      </div>
    </div>
  );
}
