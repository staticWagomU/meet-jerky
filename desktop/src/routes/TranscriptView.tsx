import { useState, useEffect, useCallback, useRef } from "react";
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
import { PermissionBanner } from "../components/PermissionBanner";

/** invoke のエラーを文字列として返すヘルパー */
function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 経過時間をフォーマットする */
function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

  // Meeting state
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [meetingStartTime, setMeetingStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Elapsed time timer
  useEffect(() => {
    if (isMeetingActive && meetingStartTime) {
      timerRef.current = setInterval(() => {
        setElapsedTime(Date.now() - meetingStartTime);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isMeetingActive, meetingStartTime]);

  const isAnySourceRecording = isMicRecording || isSystemAudioRecording;

  const handleToggleMeeting = useCallback(async () => {
    try {
      if (isMeetingActive) {
        // STOP: stop transcription, then stop audio sources
        if (isTranscribing) {
          await invoke("stop_transcription");
          setIsTranscribing(false);
        }
        if (isMicRecording) {
          await invoke("stop_recording");
          setIsMicRecording(false);
          setMicLevel(0);
        }
        if (isSystemAudioRecording) {
          await invoke("stop_system_audio");
          setIsSystemAudioRecording(false);
          setSystemAudioLevel(0);
        }
        setIsMeetingActive(false);
        setMeetingStartTime(null);
        setElapsedTime(0);
      } else {
        // START: start mic, start system audio, then start transcription
        if (selectedDeviceId) {
          await invoke("start_recording", { deviceId: selectedDeviceId });
        } else {
          await invoke("start_recording");
        }
        setIsMicRecording(true);

        await invoke("start_system_audio");
        setIsSystemAudioRecording(true);

        await invoke("start_transcription", { modelName: selectedModel });
        setIsTranscribing(true);

        const now = Date.now();
        setMeetingStartTime(now);
        setIsMeetingActive(true);
      }
    } catch (e) {
      console.error("会議操作に失敗しました:", toErrorMessage(e));
    }
  }, [
    isMeetingActive,
    isTranscribing,
    isMicRecording,
    isSystemAudioRecording,
    selectedDeviceId,
    selectedModel,
  ]);

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

  const canStartMeeting = !!isModelDownloaded && !isMeetingActive;

  return (
    <div className="transcript-view">
      <PermissionBanner />

      {/* 会議ボタン */}
      <div className="meeting-control">
        <button
          type="button"
          className={`meeting-btn ${isMeetingActive ? "meeting-btn-active" : ""}`}
          onClick={handleToggleMeeting}
          disabled={!canStartMeeting && !isMeetingActive}
        >
          <span
            className={`rec-indicator ${isMeetingActive ? "rec-indicator-active" : ""}`}
          />
          {isMeetingActive ? "会議を終了" : "会議を開始"}
        </button>
        {isMeetingActive && meetingStartTime && (
          <span className="meeting-timer">
            {formatElapsedTime(elapsedTime)}
          </span>
        )}
      </div>

      <div className="section-divider" />

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
    </div>
  );
}
