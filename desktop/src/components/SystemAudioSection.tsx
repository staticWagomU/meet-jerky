import {
  AudioLevelMeter,
  sanitizeAudioLevelForDisplay,
} from "./AudioLevelMeter";
import { OTHER_TRACK_DEVICE_LABEL } from "../utils/audioTrackLabels";

interface SystemAudioSectionProps {
  isSystemAudioRecording: boolean;
  systemAudioLevel: number;
  isOperationPending: boolean;
  isControlDisabled: boolean;
  isCompact?: boolean;
  onToggleSystemAudio: () => void;
}

export function SystemAudioSection({
  isSystemAudioRecording,
  systemAudioLevel,
  isOperationPending,
  isControlDisabled,
  isCompact = false,
  onToggleSystemAudio,
}: SystemAudioSectionProps) {
  const systemAudioLevelPercent = Math.round(
    sanitizeAudioLevelForDisplay(systemAudioLevel) * 100,
  );
  const isSystemAudioInputWaiting =
    isSystemAudioRecording && systemAudioLevelPercent === 0;
  const systemAudioStateText = isOperationPending
    ? "切替中"
    : isSystemAudioRecording
      ? "取得中"
      : "未取得";
  const systemAudioStateClassName = isOperationPending
    ? "audio-source-state-badge-pending"
    : isSystemAudioRecording
      ? "audio-source-state-badge-active"
      : "audio-source-state-badge-idle";
  const isWaitingForOtherOperation = isControlDisabled && !isOperationPending;
  const systemAudioStateDescription = `${OTHER_TRACK_DEVICE_LABEL}: ${systemAudioStateText}`;
  const systemAudioButtonLabel = isOperationPending
    ? `${OTHER_TRACK_DEVICE_LABEL}取得を切替中`
    : isControlDisabled
      ? "他の音声または文字起こし操作を待機中"
    : isSystemAudioRecording
      ? `${OTHER_TRACK_DEVICE_LABEL}取得を停止`
      : `${OTHER_TRACK_DEVICE_LABEL}取得を開始`;
  const systemAudioSectionLabel = `${systemAudioStateDescription}${isSystemAudioInputWaiting ? "、入力待ち" : ""}、音量 ${systemAudioLevelPercent}%`;

  return (
    <div
      className="audio-source-section"
      role="group"
      aria-busy={isOperationPending}
      aria-label={systemAudioSectionLabel}
      title={systemAudioSectionLabel}
    >
      <div className="audio-source-header">
        <span>相手側のシステム音声</span>
        <span
          className="audio-source-track-badge"
          aria-label={`音声トラック: ${OTHER_TRACK_DEVICE_LABEL}`}
          title={`音声トラック: ${OTHER_TRACK_DEVICE_LABEL}`}
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
        {isSystemAudioInputWaiting && (
          <span
            className="audio-source-silence-badge"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`${OTHER_TRACK_DEVICE_LABEL}: 入力待ち`}
            title={`${OTHER_TRACK_DEVICE_LABEL}: 入力待ち`}
          >
            入力待ち
          </span>
        )}
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
            ? "取得を切替中..."
            : isWaitingForOtherOperation
              ? "他操作待ち"
            : isSystemAudioRecording
              ? "相手側音声の取得を停止"
              : "相手側音声の取得を開始"}
        </button>
      </div>
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter
            level={systemAudioLevel}
            label={`${OTHER_TRACK_DEVICE_LABEL}の音量レベル`}
          />
        </div>
        <span className="level-label">{systemAudioLevelPercent}%</span>
      </div>
      {!isCompact && (
        <div className="audio-source-note">
          {OTHER_TRACK_DEVICE_LABEL}はデスクトップ/アプリ音声から取得します。macOS
          の画面収録が未許可の場合、相手側の発話は記録されません。
        </div>
      )}
    </div>
  );
}
