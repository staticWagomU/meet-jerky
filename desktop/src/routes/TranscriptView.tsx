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
import {
  startSession,
  finalizeAndSaveSession,
  discardSession,
} from "../hooks/useSession";

/** invoke のエラーを文字列として返すヘルパー */
function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

const MIC_RECORDING_ERROR_PREFIX = "マイク録音操作に失敗しました:";
const SYSTEM_AUDIO_ERROR_PREFIX = "システム音声操作に失敗しました:";
const TRANSCRIPTION_ERROR_PREFIX = "文字起こし操作に失敗しました:";
const TRANSCRIPTION_NOT_RUNNING_MESSAGE = "文字起こしは実行されていません";

function formatOperationError(prefix: string, e: unknown): string {
  return `${prefix} ${toErrorMessage(e)}`;
}

function clearRelatedMeetingError(
  currentError: string | null,
  prefix: string,
): string | null {
  return currentError?.startsWith(prefix) ? null : currentError;
}

async function stopTranscriptionFromUiState(): Promise<
  "stopped" | "already-stopped"
> {
  try {
    await invoke("stop_transcription");
    return "stopped";
  } catch (e) {
    if (toErrorMessage(e).includes(TRANSCRIPTION_NOT_RUNNING_MESSAGE)) {
      return "already-stopped";
    }
    throw e;
  }
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

function getTranscriptionSourceStatus(
  isTranscribing: boolean,
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string | null {
  if (!isTranscribing) {
    return null;
  }
  if (isMicRecording && isSystemAudioRecording) {
    return "文字起こし中: 自分 / 相手側";
  }
  if (isMicRecording) {
    return "文字起こし中: 自分のみ";
  }
  if (isSystemAudioRecording) {
    return "文字起こし中: 相手側のみ";
  }
  return "文字起こし中: 音声ソースなし";
}

function getTranscriptionSourceArg(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): "microphone" | "system_audio" | "both" | null {
  if (isMicRecording && isSystemAudioRecording) return "both";
  if (isMicRecording) return "microphone";
  if (isSystemAudioRecording) return "system_audio";
  return null;
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

  // Session wiring state
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [audioLevelListenerError, setAudioLevelListenerError] = useState<
    string | null
  >(null);

  const {
    data: devices,
    error: devicesError,
    refetch: refetchDevices,
  } = useQuery<AudioDevice[]>({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<AudioDevice[]>("list_audio_devices"),
  });

  // Check if selected model is downloaded
  const { data: isModelDownloaded, error: modelDownloadedError } =
    useQuery<boolean>({
      queryKey: ["modelDownloaded", selectedModel],
      queryFn: () =>
        invoke<boolean>("is_model_downloaded", { modelName: selectedModel }),
      enabled: !!selectedModel,
    });

  // Route audio-level events by source
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<AudioLevelPayload>("audio-level", (event) => {
      if (event.payload.source === "microphone") {
        setMicLevel(event.payload.level);
      } else if (event.payload.source === "system_audio") {
        setSystemAudioLevel(event.payload.level);
      }
    })
      .then((unlisten) => {
        if (!disposed) {
          setAudioLevelListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("音声レベル監視の開始に失敗しました:", msg);
          setAudioLevelListenerError(
            `音声レベル監視の開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error("音声レベル監視の解除に失敗しました:", toErrorMessage(e));
        });
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
    if (isMeetingActive) {
      // STOP: stop transcription, then stop audio sources, then finalize session
      try {
        if (isTranscribing) {
          await stopTranscriptionFromUiState();
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
      } catch (e) {
        const msg = toErrorMessage(e);
        console.error("会議停止に失敗しました:", msg);
        setMeetingError(`会議停止に失敗しました: ${msg}`);
        return;
      }

      // 録音停止は完了している。finalize 失敗時はユーザに通知するだけ。
      try {
        const savedPath = await finalizeAndSaveSession();
        setLastSavedPath(savedPath);
        setMeetingError(null);
      } catch (e) {
        const msg = toErrorMessage(e);
        console.error("セッション保存に失敗しました:", msg);
        setMeetingError(`セッション保存に失敗しました: ${msg}`);
      }
      return;
    }

    // START: session 開始 → mic → system audio → transcription
    const title = `会議 ${new Date().toLocaleString("ja-JP")}`;
    let sessionStarted = false;
    let micStarted = false;
    let systemAudioStarted = false;
    let transcriptionStarted = false;

    try {
      await startSession(title);
      sessionStarted = true;
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("セッション開始に失敗しました:", msg);
      setMeetingError(`セッション開始に失敗しました: ${msg}`);
      // session 開始失敗時は録音を開始しない (rollback 不要)
      return;
    }

    try {
      if (selectedDeviceId) {
        await invoke("start_recording", { deviceId: selectedDeviceId });
      } else {
        await invoke("start_recording");
      }
      micStarted = true;
      setIsMicRecording(true);

      await invoke("start_system_audio");
      systemAudioStarted = true;
      setIsSystemAudioRecording(true);

      const transcriptionSource = getTranscriptionSourceArg(
        micStarted,
        systemAudioStarted,
      );
      if (!transcriptionSource) {
        throw new Error("文字起こしに利用できる音声ソースがありません");
      }
      await invoke("start_transcription", {
        modelName: selectedModel,
        source: transcriptionSource,
      });
      transcriptionStarted = true;
      setIsTranscribing(true);

      const now = Date.now();
      setMeetingStartTime(now);
      setIsMeetingActive(true);
      setMeetingError(null);
      setLastSavedPath(null);
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("会議開始に失敗しました:", msg);
      if (transcriptionStarted) {
        await invoke("stop_transcription").catch((rollbackError) => {
          console.error(
            "文字起こしロールバックに失敗しました:",
            toErrorMessage(rollbackError),
          );
        });
      }
      if (systemAudioStarted) {
        await invoke("stop_system_audio").catch((rollbackError) => {
          console.error(
            "システム音声ロールバックに失敗しました:",
            toErrorMessage(rollbackError),
          );
        });
      }
      if (micStarted) {
        await invoke("stop_recording").catch((rollbackError) => {
          console.error(
            "マイク録音ロールバックに失敗しました:",
            toErrorMessage(rollbackError),
          );
        });
      }
      if (sessionStarted) {
        await discardSession().catch((rollbackError) => {
          console.error(
            "セッション破棄に失敗しました:",
            toErrorMessage(rollbackError),
          );
        });
      }
      setIsTranscribing(false);
      setIsSystemAudioRecording(false);
      setIsMicRecording(false);
      setSystemAudioLevel(0);
      setMicLevel(0);
      setIsMeetingActive(false);
      setMeetingStartTime(null);
      setElapsedTime(0);
      setMeetingError(`会議開始に失敗しました: ${msg}`);
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
          await stopTranscriptionFromUiState();
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
      setMeetingError((currentError) =>
        clearRelatedMeetingError(currentError, MIC_RECORDING_ERROR_PREFIX),
      );
    } catch (e) {
      const msg = formatOperationError(MIC_RECORDING_ERROR_PREFIX, e);
      console.error("マイク録音操作に失敗しました:", toErrorMessage(e));
      setMeetingError(msg);
    }
  }, [
    isMicRecording,
    isSystemAudioRecording,
    isTranscribing,
    selectedDeviceId,
  ]);

  const handleToggleSystemAudio = useCallback(async () => {
    try {
      if (isSystemAudioRecording) {
        await invoke("stop_system_audio");
        setIsSystemAudioRecording(false);
        setSystemAudioLevel(0);
        // If no source is recording, stop transcription too
        if (!isMicRecording && isTranscribing) {
          await stopTranscriptionFromUiState();
          setIsTranscribing(false);
        }
      } else {
        await invoke("start_system_audio");
        setIsSystemAudioRecording(true);
      }
      setMeetingError((currentError) =>
        clearRelatedMeetingError(currentError, SYSTEM_AUDIO_ERROR_PREFIX),
      );
    } catch (e) {
      const msg = formatOperationError(SYSTEM_AUDIO_ERROR_PREFIX, e);
      console.error("システム音声操作に失敗しました:", toErrorMessage(e));
      setMeetingError(msg);
    }
  }, [isSystemAudioRecording, isMicRecording, isTranscribing]);

  const handleToggleTranscription = useCallback(async () => {
    try {
      if (isTranscribing) {
        await stopTranscriptionFromUiState();
        setIsTranscribing(false);
      } else {
        if (isMicRecording) {
          if (selectedDeviceId) {
            await invoke("start_recording", { deviceId: selectedDeviceId });
          } else {
            await invoke("start_recording");
          }
          setMicLevel(0);
        }
        if (isSystemAudioRecording) {
          await invoke("start_system_audio");
          setSystemAudioLevel(0);
        }
        const transcriptionSource = getTranscriptionSourceArg(
          isMicRecording,
          isSystemAudioRecording,
        );
        if (!transcriptionSource) {
          throw new Error("文字起こしに利用できる音声ソースがありません");
        }
        await invoke("start_transcription", {
          modelName: selectedModel,
          source: transcriptionSource,
        });
        setIsTranscribing(true);
      }
      setMeetingError((currentError) =>
        clearRelatedMeetingError(currentError, TRANSCRIPTION_ERROR_PREFIX),
      );
    } catch (e) {
      const msg = formatOperationError(TRANSCRIPTION_ERROR_PREFIX, e);
      console.error("文字起こし操作に失敗しました:", toErrorMessage(e));
      setMeetingError(msg);
    }
  }, [
    isTranscribing,
    isMicRecording,
    isSystemAudioRecording,
    selectedDeviceId,
    selectedModel,
  ]);

  const handleNewSegment = useCallback((segment: TranscriptSegment) => {
    setSegments((prev) => [...prev, segment]);
  }, []);

  const handleClearTranscript = useCallback(() => {
    setSegments([]);
  }, []);

  const canStartTranscription =
    isAnySourceRecording && !!isModelDownloaded && !isTranscribing;

  const canStartMeeting = !!isModelDownloaded && !isMeetingActive;

  const transcriptionSourceStatus = getTranscriptionSourceStatus(
    isTranscribing,
    isMicRecording,
    isSystemAudioRecording,
  );

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
        {meetingError && (
          <p className="meeting-error" role="alert">
            {meetingError}
          </p>
        )}
        {modelDownloadedError && (
          <p className="meeting-error" role="alert">
            モデル状態の確認に失敗しました: {String(modelDownloadedError)}
          </p>
        )}
        {audioLevelListenerError && (
          <p className="meeting-error" role="alert">
            {audioLevelListenerError}
          </p>
        )}
        {lastSavedPath && (
          <p className="meeting-saved-path">保存先: {lastSavedPath}</p>
        )}
      </div>

      <div className="section-divider" />

      <MicrophoneSection
        isMicRecording={isMicRecording}
        micLevel={micLevel}
        selectedDeviceId={selectedDeviceId}
        audioDevices={devices}
        audioDevicesError={devicesError}
        onDeviceChange={setSelectedDeviceId}
        onRetryDevices={() => refetchDevices()}
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
        sourceStatusText={transcriptionSourceStatus}
        segmentsCount={segments.length}
        onClearTranscript={handleClearTranscript}
      />

      <TranscriptDisplay segments={segments} onNewSegment={handleNewSegment} />
    </div>
  );
}
