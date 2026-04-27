import type { AudioDevice } from "../types";
import {
  AudioLevelMeter,
  sanitizeAudioLevelForDisplay,
} from "./AudioLevelMeter";

interface MicrophoneSectionProps {
  isMicRecording: boolean;
  micLevel: number;
  selectedDeviceId: string;
  audioDevices: AudioDevice[] | undefined;
  audioDevicesError: unknown;
  isReloadingAudioDevices: boolean;
  isOperationPending: boolean;
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
  onDeviceChange,
  onRetryDevices,
  onToggleRecording,
}: MicrophoneSectionProps) {
  const micLevelPercent = Math.round(
    sanitizeAudioLevelForDisplay(micLevel) * 100,
  );
  const micStateText = isOperationPending
    ? "処理中"
    : isMicRecording
      ? "録音中"
      : "未録音";
  const micStateClassName = isOperationPending
    ? "audio-source-state-badge-pending"
    : isMicRecording
      ? "audio-source-state-badge-active"
      : "audio-source-state-badge-idle";
  const micStateDescription = `マイク 自分トラック: ${micStateText}`;
  const micButtonLabel = isOperationPending
    ? "自分トラックのマイク録音を処理中"
    : isMicRecording
      ? "自分トラックのマイク録音を停止"
      : "自分トラックのマイク録音を開始";
  const deviceSelectLabel =
    isMicRecording || isOperationPending
      ? "マイクデバイス: 録音中または処理中は変更できません"
      : "マイクデバイス: 自分トラックの入力を選択";
  const retryDevicesLabel = isReloadingAudioDevices
    ? "マイクデバイス一覧を取得中"
    : "マイクデバイス一覧を再取得";

  return (
    <div
      className="audio-source-section"
      role="group"
      aria-busy={isOperationPending}
      aria-label="マイク 自分トラック"
      title="マイク 自分トラック"
    >
      <div className="audio-source-header">
        <span>マイク</span>
        <span className="audio-source-track-badge">自分</span>
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
      </div>
      <div className="controls-row">
        <div className="device-selector">
          <select
            id="device-select"
            aria-label={deviceSelectLabel}
            title={deviceSelectLabel}
            value={selectedDeviceId}
            onChange={(e) => onDeviceChange(e.target.value)}
            disabled={isMicRecording || isOperationPending}
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
          disabled={isOperationPending}
          className={`control-btn ${isMicRecording ? "control-btn-stop" : "control-btn-record"}`}
          aria-label={micButtonLabel}
          title={micButtonLabel}
        >
          <span
            className={`rec-indicator ${isMicRecording ? "rec-indicator-active" : ""}`}
            aria-hidden="true"
          />
          {isOperationPending
            ? "処理中..."
            : isMicRecording
              ? "録音停止"
              : "録音開始"}
        </button>
      </div>
      {Boolean(audioDevicesError) && (
        <div
          className="settings-inline-error"
          role="alert"
          aria-label={`マイク 自分トラックのデバイス一覧エラー: ${String(audioDevicesError)}`}
          title={`マイク 自分トラックのデバイス一覧エラー: ${String(audioDevicesError)}`}
        >
          <span>
            マイクデバイス一覧の取得に失敗しました: {String(audioDevicesError)}
          </span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={onRetryDevices}
            disabled={isReloadingAudioDevices}
            aria-label={retryDevicesLabel}
            title={retryDevicesLabel}
          >
            {isReloadingAudioDevices ? "取得中..." : "再取得"}
          </button>
        </div>
      )}
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter
            level={micLevel}
            label="マイク 自分トラック音量レベル"
          />
        </div>
        <span className="level-label">{micLevelPercent}%</span>
      </div>
      <div className="audio-source-note">
        マイク音声は自分トラックとして文字起こしされます
      </div>
    </div>
  );
}
