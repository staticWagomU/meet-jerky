import { AudioLevelMeter } from "./AudioLevelMeter";
import { sanitizeAudioLevel } from "../utils/audioLevelHelpers";
import { OTHER_TRACK_DEVICE_LABEL } from "../utils/audioTrackLabels";

interface SystemAudioSectionProps {
  isSystemAudioRecording: boolean;
  systemAudioLevel: number;
  systemAudioDropCountTotal: number;
  isOperationPending: boolean;
  isControlDisabled: boolean;
  isCompact?: boolean;
  onToggleSystemAudio: () => void;
}

export function SystemAudioSection({
  isSystemAudioRecording,
  systemAudioLevel,
  systemAudioDropCountTotal,
  isOperationPending,
  isControlDisabled,
  isCompact = false,
  onToggleSystemAudio,
}: SystemAudioSectionProps) {
  const systemAudioLevelPercent = Math.round(
    sanitizeAudioLevel(systemAudioLevel) * 100,
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
      ? `${OTHER_TRACK_DEVICE_LABEL}取得を停止。停止すると相手側の発話は文字起こしされません`
      : `${OTHER_TRACK_DEVICE_LABEL}取得を開始。相手側の発話を文字起こしします`;
  const systemAudioInputWaitingLabel =
    `${OTHER_TRACK_DEVICE_LABEL}: 入力待ち。音量 0%。会議アプリの音声出力、システム音量、macOS の画面収録権限を確認してください`;
  const systemAudioSectionLabel = `${systemAudioStateDescription}${isSystemAudioInputWaiting ? `、${systemAudioInputWaitingLabel}` : ""}、音量 ${systemAudioLevelPercent}%`;

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
            aria-label={systemAudioInputWaitingLabel}
            title={systemAudioInputWaitingLabel}
          >
            入力待ち
          </span>
        )}
        {systemAudioDropCountTotal > 0 && (
          <span
            className="audio-source-drop-badge"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`${OTHER_TRACK_DEVICE_LABEL}: ${systemAudioDropCountTotal} サンプル破棄`}
            title={`${OTHER_TRACK_DEVICE_LABEL}: ${systemAudioDropCountTotal} サンプル破棄`}
          >
            破棄 {systemAudioDropCountTotal}
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
