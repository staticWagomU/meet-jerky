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
    ? `${OTHER_TRACK_DEVICE_LABEL}を切替中`
    : isControlDisabled
      ? "他の操作を待機中"
      : isSystemAudioRecording
        ? `${OTHER_TRACK_DEVICE_LABEL}を停止`
        : `${OTHER_TRACK_DEVICE_LABEL}を取得`;
  const systemAudioInputWaitingLabel = `${OTHER_TRACK_DEVICE_LABEL}: 入力待ち。会議音声と画面収録権限を確認`;
  const systemAudioSectionLabel = `${systemAudioStateDescription}${isSystemAudioInputWaiting ? `、${systemAudioInputWaitingLabel}` : ""}、音量 ${systemAudioLevelPercent}%`;
  const systemAudioBoundaryItems = [
    {
      label: "トラック",
      value: "相手側",
      detail: OTHER_TRACK_DEVICE_LABEL,
      tone: "ready",
    },
    {
      label: "入力",
      value: `${systemAudioLevelPercent}%`,
      detail: isSystemAudioInputWaiting ? "入力待ち" : "レベル",
      tone: isSystemAudioInputWaiting
        ? "warn"
        : isSystemAudioRecording
          ? "ready"
          : "muted",
    },
    {
      label: "相手側音声",
      value: isSystemAudioRecording ? "取得中" : "取得待機",
      detail: "文字起こし対象",
      tone: isSystemAudioRecording ? "ready" : "muted",
    },
    {
      label: "音声外部送信",
      value: "外部送信なし",
      detail: "音声トラック",
      tone: "ready",
    },
  ] as const;

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
            aria-label={`${OTHER_TRACK_DEVICE_LABEL}: 音声欠落 ${systemAudioDropCountTotal} 件`}
            title={`${OTHER_TRACK_DEVICE_LABEL}: 音声欠落 ${systemAudioDropCountTotal} 件`}
          >
            欠落 {systemAudioDropCountTotal}
          </span>
        )}
      </div>
      <div
        className="audio-source-boundary-grid"
        aria-label={`${OTHER_TRACK_DEVICE_LABEL}: ${isSystemAudioRecording ? "取得中" : "未取得"}、音量 ${systemAudioLevelPercent}%、音声は外部送信しません`}
        title={`${OTHER_TRACK_DEVICE_LABEL}の取得境界`}
      >
        {systemAudioBoundaryItems.map((item) => (
          <span
            key={item.label}
            className={`audio-source-boundary-item audio-source-boundary-item-${item.tone}`}
          >
            <strong>{item.label}</strong>
            <small>{item.value}</small>
            <em>{item.detail}</em>
          </span>
        ))}
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
            ? "取得を切替中…"
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
          {OTHER_TRACK_DEVICE_LABEL}はデスクトップ/アプリ音声から取得します。
        </div>
      )}
    </div>
  );
}
