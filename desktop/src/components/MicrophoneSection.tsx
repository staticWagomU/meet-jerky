import type { AudioDevice } from "../types";
import {
  AudioLevelMeter,
  sanitizeAudioLevelForDisplay,
} from "./AudioLevelMeter";
import { toErrorMessage } from "../utils/errorMessage";

interface MicrophoneSectionProps {
  isMicRecording: boolean;
  micLevel: number;
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
  const micLevelPercent = Math.round(
    sanitizeAudioLevelForDisplay(micLevel) * 100,
  );
  const isMicInputWaiting = isMicRecording && micLevelPercent === 0;
  const micStateText = isOperationPending
    ? "切替中"
    : isMicRecording
      ? "録音中"
      : "未録音";
  const micStateClassName = isOperationPending
    ? "audio-source-state-badge-pending"
    : isMicRecording
      ? "audio-source-state-badge-active"
      : "audio-source-state-badge-idle";
  const isWaitingForOtherOperation = isControlDisabled && !isOperationPending;
  const micStateDescription = `自分トラック マイク: ${micStateText}`;
  const micButtonLabel = isOperationPending
    ? "自分トラックのマイク録音を切替中"
    : isControlDisabled
      ? "他の音声または文字起こし操作を待機中"
    : isMicRecording
      ? "自分トラックのマイク録音を停止"
      : "自分トラックのマイク録音を開始";
  const deviceSelectLabel =
    isMicRecording || isOperationPending
      ? "マイクデバイス: 録音中または切替中は変更できません"
      : isControlDisabled
        ? "マイクデバイス: 他の音声または文字起こし操作を待機中は変更できません"
      : "マイクデバイス: 自分トラックの入力を選択";
  const retryDevicesLabel = isReloadingAudioDevices
    ? "自分トラックのマイクデバイス一覧を取得中"
    : "自分トラックのマイクデバイス一覧を再取得";
  const audioDevicesErrorMessage = audioDevicesError
    ? toErrorMessage(audioDevicesError)
    : "";
  const micSectionLabel = `${micStateDescription}、音量 ${micLevelPercent}%`;

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
          aria-label="音声トラック: 自分"
          title="音声トラック: 自分"
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
            aria-label="自分トラック マイク: 入力待ち"
            title="自分トラック マイク: 入力待ち"
          >
            入力待ち
          </span>
        )}
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
            ? "録音を切替中..."
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
          aria-label={`自分トラック マイクのデバイス一覧エラー: ${audioDevicesErrorMessage}`}
          title={`自分トラック マイクのデバイス一覧エラー: ${audioDevicesErrorMessage}`}
        >
          <span>
            自分トラックのマイクデバイス一覧の取得に失敗しました:{" "}
            {audioDevicesErrorMessage}
          </span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={onRetryDevices}
            disabled={isReloadingAudioDevices}
            aria-label={retryDevicesLabel}
            title={retryDevicesLabel}
          >
            {isReloadingAudioDevices ? "取得中..." : "デバイスを再取得"}
          </button>
        </div>
      )}
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter
            level={micLevel}
            label="自分トラック マイクの音量レベル"
          />
        </div>
        <span className="level-label">{micLevelPercent}%</span>
      </div>
      {!isCompact && (
        <div className="audio-source-note">
          マイク音声は自分トラックとして文字起こしされます
        </div>
      )}
    </div>
  );
}
