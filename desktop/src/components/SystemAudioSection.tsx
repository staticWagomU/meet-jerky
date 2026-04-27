import {
  AudioLevelMeter,
  sanitizeAudioLevelForDisplay,
} from "./AudioLevelMeter";

interface SystemAudioSectionProps {
  isSystemAudioRecording: boolean;
  systemAudioLevel: number;
  isOperationPending: boolean;
  isControlDisabled: boolean;
  onToggleSystemAudio: () => void;
}

export function SystemAudioSection({
  isSystemAudioRecording,
  systemAudioLevel,
  isOperationPending,
  isControlDisabled,
  onToggleSystemAudio,
}: SystemAudioSectionProps) {
  const systemAudioLevelPercent = Math.round(
    sanitizeAudioLevelForDisplay(systemAudioLevel) * 100,
  );
  const systemAudioStateText = isOperationPending
    ? "処理中"
    : isSystemAudioRecording
      ? "取得中"
      : "未取得";
  const systemAudioStateClassName = isOperationPending
    ? "audio-source-state-badge-pending"
    : isSystemAudioRecording
      ? "audio-source-state-badge-active"
      : "audio-source-state-badge-idle";
  const isWaitingForOtherOperation = isControlDisabled && !isOperationPending;
  const systemAudioStateDescription = `システム音声 相手側トラック: ${systemAudioStateText}`;
  const systemAudioButtonLabel = isOperationPending
    ? "相手側トラックのシステム音声キャプチャを処理中"
    : isControlDisabled
      ? "他の音声または文字起こし操作の処理中"
    : isSystemAudioRecording
      ? "相手側トラックのシステム音声キャプチャを停止"
      : "相手側トラックのシステム音声キャプチャを開始";

  return (
    <div
      className="audio-source-section"
      role="group"
      aria-busy={isOperationPending}
      aria-label="システム音声 相手側トラック"
      title="システム音声 相手側トラック"
    >
      <div className="audio-source-header">
        <span>システム音声</span>
        <span
          className="audio-source-track-badge"
          aria-label="音声トラック: 相手側"
          title="音声トラック: 相手側"
        >
          相手側
        </span>
        <span
          className={`audio-source-state-badge ${systemAudioStateClassName}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={systemAudioStateDescription}
          title={systemAudioStateDescription}
        >
          {systemAudioStateText}
        </span>
      </div>
      <div className="controls-row">
        <button
          type="button"
          onClick={onToggleSystemAudio}
          disabled={isControlDisabled}
          className={`control-btn ${isSystemAudioRecording ? "control-btn-stop" : "control-btn-capture"}`}
          aria-label={systemAudioButtonLabel}
          title={systemAudioButtonLabel}
        >
          <span
            className={`rec-indicator ${isSystemAudioRecording ? "rec-indicator-active" : ""}`}
            aria-hidden="true"
          />
          {isOperationPending
            ? "処理中..."
            : isWaitingForOtherOperation
              ? "操作待ち"
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
