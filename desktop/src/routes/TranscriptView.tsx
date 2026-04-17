import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import { AudioLevelMeter } from "../components/AudioLevelMeter";
import {
  TranscriptDisplay,
  type TranscriptSegment,
} from "../components/TranscriptDisplay";
import { ModelSelector } from "../components/ModelSelector";

/** invoke のエラーを文字列として返すヘルパー */
function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

interface AudioDevice {
  name: string;
  id: string;
}

interface AudioLevelPayload {
  source: "microphone" | "system_audio";
  level: number;
}

export function TranscriptView() {
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [isSystemAudioRecording, setIsSystemAudioRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [systemAudioLevel, setSystemAudioLevel] = useState(0);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("small");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  const { data: devices } = useQuery<AudioDevice[]>({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<AudioDevice[]>("list_audio_devices"),
  });

  // Check if selected model is downloaded
  const { data: isModelDownloaded } = useQuery<boolean>({
    queryKey: ["modelDownloaded", selectedModel],
    queryFn: () =>
      invoke<boolean>("is_model_downloaded", { modelName: selectedModel }),
    enabled: !!selectedModel,
  });

  // Route audio-level events by source
  useEffect(() => {
    const unlistenPromise = listen<AudioLevelPayload>(
      "audio-level",
      (event) => {
        if (event.payload.source === "microphone") {
          setMicLevel(event.payload.level);
        } else if (event.payload.source === "system_audio") {
          setSystemAudioLevel(event.payload.level);
        }
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const isAnySourceRecording = isMicRecording || isSystemAudioRecording;

  const handleToggleMicRecording = useCallback(async () => {
    try {
      if (isMicRecording) {
        await invoke("stop_recording");
        setIsMicRecording(false);
        setMicLevel(0);
        // If no source is recording, stop transcription too
        if (!isSystemAudioRecording && isTranscribing) {
          await invoke("stop_transcription");
          setIsTranscribing(false);
        }
      } else {
        if (selectedDeviceId) {
          await invoke("start_recording", { deviceId: selectedDeviceId });
        } else {
          await invoke("start_recording");
        }
        setIsMicRecording(true);
      }
    } catch (e) {
      console.error("マイク録音操作に失敗しました:", toErrorMessage(e));
    }
  }, [isMicRecording, isSystemAudioRecording, isTranscribing, selectedDeviceId]);

  const handleToggleSystemAudio = useCallback(async () => {
    try {
      if (isSystemAudioRecording) {
        await invoke("stop_system_audio");
        setIsSystemAudioRecording(false);
        setSystemAudioLevel(0);
        // If no source is recording, stop transcription too
        if (!isMicRecording && isTranscribing) {
          await invoke("stop_transcription");
          setIsTranscribing(false);
        }
      } else {
        await invoke("start_system_audio");
        setIsSystemAudioRecording(true);
      }
    } catch (e) {
      console.error("システム音声操作に失敗しました:", toErrorMessage(e));
    }
  }, [isSystemAudioRecording, isMicRecording, isTranscribing]);

  const handleToggleTranscription = useCallback(async () => {
    try {
      if (isTranscribing) {
        await invoke("stop_transcription");
        setIsTranscribing(false);
      } else {
        await invoke("start_transcription", { modelName: selectedModel });
        setIsTranscribing(true);
      }
    } catch (e) {
      console.error("文字起こし操作に失敗しました:", toErrorMessage(e));
    }
  }, [isTranscribing, selectedModel]);

  const handleNewSegment = useCallback((segment: TranscriptSegment) => {
    setSegments((prev) => [...prev, segment]);
  }, []);

  const handleClearTranscript = useCallback(() => {
    setSegments([]);
  }, []);

  const canStartTranscription =
    isAnySourceRecording && !!isModelDownloaded && !isTranscribing;

  return (
    <div className="transcript-view">
      {/* Microphone section */}
      <div className="audio-source-section">
        <div className="audio-source-header">マイク</div>
        <div className="controls-row">
          <div className="device-selector">
            <select
              id="device-select"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              disabled={isMicRecording}
              className="device-select"
            >
              <option value="">デフォルト</option>
              {devices?.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={handleToggleMicRecording}
            className={`control-btn ${isMicRecording ? "control-btn-stop" : "control-btn-record"}`}
          >
            <span
              className={`rec-indicator ${isMicRecording ? "rec-indicator-active" : ""}`}
            />
            {isMicRecording ? "録音停止" : "録音開始"}
          </button>
        </div>
        <div className="level-meter-row">
          <span className="level-label">レベル</span>
          <div className="level-meter-bar">
            <AudioLevelMeter level={micLevel} />
          </div>
          <span className="level-label">{Math.round(micLevel * 100)}%</span>
        </div>
      </div>

      {/* System audio section */}
      <div className="audio-source-section">
        <div className="audio-source-header">システム音声</div>
        <div className="controls-row">
          <button
            type="button"
            onClick={handleToggleSystemAudio}
            className={`control-btn ${isSystemAudioRecording ? "control-btn-stop" : "control-btn-capture"}`}
          >
            <span
              className={`rec-indicator ${isSystemAudioRecording ? "rec-indicator-active" : ""}`}
            />
            {isSystemAudioRecording ? "キャプチャ停止" : "キャプチャ開始"}
          </button>
        </div>
        <div className="level-meter-row">
          <span className="level-label">レベル</span>
          <div className="level-meter-bar">
            <AudioLevelMeter level={systemAudioLevel} />
          </div>
          <span className="level-label">
            {Math.round(systemAudioLevel * 100)}%
          </span>
        </div>
        <div className="system-audio-note">
          macOSの画面収録の許可が必要です
        </div>
      </div>

      <div className="section-divider" />

      {/* Transcription controls */}
      <div className="controls-row">
        <ModelSelector
          selectedModel={selectedModel}
          onSelectModel={setSelectedModel}
          disabled={isTranscribing}
        />
      </div>

      <div className="controls-row">
        <button
          type="button"
          onClick={handleToggleTranscription}
          disabled={!canStartTranscription && !isTranscribing}
          className={`control-btn ${isTranscribing ? "control-btn-transcribing" : "control-btn-transcribe"}`}
        >
          {isTranscribing ? "文字起こし停止" : "文字起こし開始"}
        </button>

        {segments.length > 0 && (
          <button
            type="button"
            onClick={handleClearTranscript}
            className="control-btn control-btn-clear"
          >
            クリア
          </button>
        )}
      </div>

      {/* Transcript display */}
      <TranscriptDisplay segments={segments} onNewSegment={handleNewSegment} />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
