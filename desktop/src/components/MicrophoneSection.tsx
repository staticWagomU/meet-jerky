import type { AudioDevice } from "../types";
import { AudioLevelMeter } from "./AudioLevelMeter";

interface MicrophoneSectionProps {
  isMicRecording: boolean;
  micLevel: number;
  selectedDeviceId: string;
  audioDevices: AudioDevice[] | undefined;
  audioDevicesError: unknown;
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
  onDeviceChange,
  onRetryDevices,
  onToggleRecording,
}: MicrophoneSectionProps) {
  return (
    <div className="audio-source-section">
      <div className="audio-source-header">マイク</div>
      <div className="controls-row">
        <div className="device-selector">
          <select
            id="device-select"
            aria-label="マイクデバイス"
            value={selectedDeviceId}
            onChange={(e) => onDeviceChange(e.target.value)}
            disabled={isMicRecording}
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
          className={`control-btn ${isMicRecording ? "control-btn-stop" : "control-btn-record"}`}
        >
          <span
            className={`rec-indicator ${isMicRecording ? "rec-indicator-active" : ""}`}
          />
          {isMicRecording ? "録音停止" : "録音開始"}
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
          >
            再取得
          </button>
        </div>
      )}
      <div className="level-meter-row">
        <span className="level-label">レベル</span>
        <div className="level-meter-bar">
          <AudioLevelMeter level={micLevel} />
        </div>
        <span className="level-label">{Math.round(micLevel * 100)}%</span>
      </div>
    </div>
  );
}
