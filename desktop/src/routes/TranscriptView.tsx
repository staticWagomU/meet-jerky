import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import type {
  AudioDevice,
  AudioLevelPayload,
  TranscriptSegment,
} from "../types";
import { MicrophoneSection } from "../components/MicrophoneSection";
import { SystemAudioSection } from "../components/SystemAudioSection";
import { TranscriptionControls } from "../components/TranscriptionControls";
import { TranscriptDisplay } from "../components/TranscriptDisplay";

/** invoke のエラーを文字列として返すヘルパー */
function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
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
      <MicrophoneSection
        isMicRecording={isMicRecording}
        micLevel={micLevel}
        selectedDeviceId={selectedDeviceId}
        audioDevices={devices}
        onDeviceChange={setSelectedDeviceId}
        onToggleRecording={handleToggleMicRecording}
      />

      <SystemAudioSection
        isSystemAudioRecording={isSystemAudioRecording}
        systemAudioLevel={systemAudioLevel}
        onToggleSystemAudio={handleToggleSystemAudio}
      />

      <div className="section-divider" />

      <TranscriptionControls
        isTranscribing={isTranscribing}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        onToggleTranscription={handleToggleTranscription}
        canStartTranscription={canStartTranscription}
        segmentsCount={segments.length}
        onClearTranscript={handleClearTranscript}
      />

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
