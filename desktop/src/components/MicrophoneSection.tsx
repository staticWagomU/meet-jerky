import type { AudioDevice } from "../types";
import { AudioLevelMeter } from "./AudioLevelMeter";
import { sanitizeAudioLevel } from "../utils/audioLevelHelpers";
import { SELF_TRACK_DEVICE_LABEL } from "../utils/audioTrackLabels";
import { toErrorMessage } from "../utils/errorMessage";
import { STATUS_RECORDING_LABEL } from "../utils/statusLabels";

interface MicrophoneSectionProps {
  isMicRecording: boolean;
  micLevel: number;
  micDropCountTotal: number;
  selectedDeviceId: string;
  audioDevices: AudioDevice[] | undefined;
  audioDevicesError: unknown;
  isReloadingAudioDevices: boolean;
  isOperationPending: boolean;
  isControlDisabled: boolean;
  isCompact?: boolean;
  onDeviceChange: (deviceId: string) => void;
  onRetryDevices: () => void;
  onToggleRecording: () => void;
}

export function MicrophoneSection({
  isMicRecording,
  micLevel,
  micDropCountTotal,
  selectedDeviceId,
  audioDevices,
  audioDevicesError,
  isReloadingAudioDevices,
  isOperationPending,
  isControlDisabled,
  isCompact = false,
  onDeviceChange,
  onRetryDevices,
  onToggleRecording,
}: MicrophoneSectionProps) {
  const micLevelPercent = Math.round(sanitizeAudioLevel(micLevel) * 100);
  const isMicInputWaiting = isMicRecording && micLevelPercent === 0;
  const micStateText = isOperationPending
    ? "切替中"
    : isMicRecording
      ? STATUS_RECORDING_LABEL
      : "未録音";
  const micStateClassName = isOperationPending
    ? "audio-source-state-badge-pending"
    : isMicRecording
      ? "audio-source-state-badge-active"
      : "audio-source-state-badge-idle";
  const isWaitingForOtherOperation = isControlDisabled && !isOperationPending;
  const micStateDescription = `${SELF_TRACK_DEVICE_LABEL}: ${micStateText}`;
  const micButtonLabel = isOperationPending
    ? `${SELF_TRACK_DEVICE_LABEL}を切替中`
    : isControlDisabled
      ? "他の操作を待機中"
      : isMicRecording
        ? `${SELF_TRACK_DEVICE_LABEL}を停止`
        : `${SELF_TRACK_DEVICE_LABEL}を録音`;
  const deviceSelectLabel =
    isMicRecording || isOperationPending
      ? "マイク: 録音中は変更不可"
      : isControlDisabled
        ? "マイク: 他の操作を待機中"
        : "マイク入力を選択";
  const retryDevicesLabel = isReloadingAudioDevices
    ? `${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を取得中`
    : `${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を再取得`;
  const audioDevicesErrorMessage = audioDevicesError
    ? toErrorMessage(audioDevicesError)
    : "";
  const micInputWaitingLabel = `${SELF_TRACK_DEVICE_LABEL}: 入力待ち。マイクと権限を確認`;
  const micSectionLabel = `${micStateDescription}${isMicInputWaiting ? `、${micInputWaitingLabel}` : ""}、音量 ${micLevelPercent}%`;
  const micBoundaryItems = [
    {
      label: "トラック",
      value: "自分",
      detail: SELF_TRACK_DEVICE_LABEL,
      tone: "ready",
    },
    {
      label: "入力",
      value: `${micLevelPercent}%`,
      detail: isMicInputWaiting ? "入力待ち" : "レベル",
      tone: isMicInputWaiting ? "warn" : isMicRecording ? "ready" : "muted",
    },
    {
      label: "自分音声",
      value: isMicRecording ? "録音中" : "録音待機",
      detail: "文字起こし対象",
      tone: isMicRecording ? "ready" : "muted",
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
      aria-label={micSectionLabel}
      title={micSectionLabel}
    >
      <div className="audio-source-header">
        <span>自分のマイク</span>
        <span
          className="audio-source-track-badge"
          aria-label={`音声トラック: ${SELF_TRACK_DEVICE_LABEL}`}
          title={`音声トラック: ${SELF_TRACK_DEVICE_LABEL}`}
        >
          自分
        </span>
        <span
          className={`audio-source-state-badge ${micStateClassName}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={micStateDescription}
          title={micStateDescription}
        >
          {micStateText}
        </span>
        {isMicInputWaiting && (
          <span
            className="audio-source-silence-badge"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={micInputWaitingLabel}
            title={micInputWaitingLabel}
          >
            入力待ち
          </span>
        )}
        {micDropCountTotal > 0 && (
          <span
            className="audio-source-drop-badge"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`${SELF_TRACK_DEVICE_LABEL}: 音声欠落 ${micDropCountTotal} 件`}
            title={`${SELF_TRACK_DEVICE_LABEL}: 音声欠落 ${micDropCountTotal} 件`}
          >
            欠落 {micDropCountTotal}
          </span>
        )}
      </div>
      <div
        className="audio-source-boundary-grid"
        aria-label={`${SELF_TRACK_DEVICE_LABEL}: ${isMicRecording ? "録音中" : "未録音"}、音量 ${micLevelPercent}%、音声は外部送信しません`}
        title={`${SELF_TRACK_DEVICE_LABEL}の取得境界`}
      >
        {micBoundaryItems.map((item) => (
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
        <div className="device-selector">
          <select
            id="device-select"
            aria-label={deviceSelectLabel}
            title={deviceSelectLabel}
            value={selectedDeviceId}
            onChange={(e) => onDeviceChange(e.target.value)}
            disabled={isMicRecording || isOperationPending || isControlDisabled}
            className="device-select"
          >
            <option value="">デフォルト</option>
            {audioDevices?.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onToggleRecording}
          disabled={isControlDisabled}
          className={`control-btn ${isMicRecording ? "control-btn-stop" : "control-btn-record"}`}
          aria-label={micButtonLabel}
          title={micButtonLabel}
        >
          <span
            className={`rec-indicator ${isMicRecording ? "rec-indicator-active" : ""}`}
            aria-hidden="true"
          />
          {isOperationPending
            ? "録音を切替中…"
            : isWaitingForOtherOperation
              ? "他操作待ち"
              : isMicRecording
                ? "自分の録音を停止"
                : "自分の録音を開始"}
        </button>
      </div>
      {Boolean(audioDevicesError) && (
        <div
          className="settings-inline-error"
          role="alert"
          aria-label={`${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を取得できません`}
          title={audioDevicesErrorMessage}
        >
          <span>マイク一覧を取得できません。</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={onRetryDevices}
            disabled={isReloadingAudioDevices}
            aria-label={retryDevicesLabel}
            title={retryDevicesLabel}
          >
            {isReloadingAudioDevices
              ? "マイク一覧取得中…"
              : "マイク一覧を再取得"}
          </button>
        </div>
      )}
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter
            level={micLevel}
            label={`${SELF_TRACK_DEVICE_LABEL}の音量レベル`}
          />
        </div>
        <span className="level-label">{micLevelPercent}%</span>
      </div>
      {!isCompact && (
        <div className="audio-source-note">
          マイク音声は{SELF_TRACK_DEVICE_LABEL}として記録します。
        </div>
      )}
    </div>
  );
}
