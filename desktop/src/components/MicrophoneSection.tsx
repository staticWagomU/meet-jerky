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

  return (
    <div className="audio-source-section">
      <div className="audio-source-header">
        <span>マイク</span>
        <span className="audio-source-track-badge">自分</span>
        <span
          className={`audio-source-state-badge ${
            isMicRecording
              ? "audio-source-state-badge-active"
              : "audio-source-state-badge-idle"
          }`}
        >
          {isMicRecording ? "録音中" : "待機中"}
        </span>
      </div>
      <div className="controls-row">
        <div className="device-selector">
          <select
            id="device-select"
            aria-label="マイクデバイス"
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
        >
          <span
            className={`rec-indicator ${isMicRecording ? "rec-indicator-active" : ""}`}
          />
          {isOperationPending
            ? "処理中..."
            : isMicRecording
              ? "録音停止"
              : "録音開始"}
        </button>
      </div>
      {Boolean(audioDevicesError) && (
        <div className="settings-inline-error" role="alert">
          <span>
            マイクデバイス一覧の取得に失敗しました: {String(audioDevicesError)}
          </span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={onRetryDevices}
            disabled={isReloadingAudioDevices}
          >
            {isReloadingAudioDevices ? "取得中..." : "再取得"}
          </button>
        </div>
      )}
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter level={micLevel} />
        </div>
        <span className="level-label">{micLevelPercent}%</span>
      </div>
    </div>
  );
}
