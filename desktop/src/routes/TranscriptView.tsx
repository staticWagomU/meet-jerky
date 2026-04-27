import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import type {
  AppSettings,
  AudioDevice,
  AudioLevelPayload,
  TranscriptSegment,
  TranscriptionEngineType,
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
import { toErrorMessage } from "../utils/errorMessage";

const MIC_RECORDING_ERROR_PREFIX = "マイク録音操作に失敗しました:";
const SYSTEM_AUDIO_ERROR_PREFIX = "相手側音声の取得操作に失敗しました:";
const TRANSCRIPTION_ERROR_PREFIX = "文字起こし操作に失敗しました:";
const TRANSCRIPTION_NOT_RUNNING_MESSAGE = "文字起こしは実行されていません";
const MEETING_START_BLOCKED_REASON_ID = "meeting-start-blocked-reason";

function formatOperationError(prefix: string, e: unknown): string {
  return `${prefix} ${toErrorMessage(e)}`;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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
    return "文字起こし中: 自分のみ / 相手側未取得";
  }
  if (isSystemAudioRecording) {
    return "文字起こし中: 相手側のみ / 自分未取得";
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

function getTranscriptionStartBlockedReason(
  isTranscribing: boolean,
  isAnySourceRecording: boolean,
  requiresLocalModel: boolean,
  isModelDownloaded: boolean | undefined,
  modelDownloadedError: unknown,
  externalApiProvider: string | null,
  hasExternalApiKey: boolean | undefined,
  externalApiKeyError: unknown,
): string | null {
  if (isTranscribing) return null;
  if (modelDownloadedError) return null;
  if (externalApiKeyError && externalApiProvider) {
    return `${externalApiProvider} API キー状態を確認できません。`;
  }
  if (!isAnySourceRecording) {
    return "文字起こし開始には、自分トラックのマイク録音または相手側トラックのシステム音声取得を開始してください。";
  }
  if (externalApiProvider && hasExternalApiKey === undefined) {
    return `${externalApiProvider} API キー状態を確認中です。`;
  }
  if (externalApiProvider && !hasExternalApiKey) {
    return `${externalApiProvider} Realtime の利用には、設定画面で API キーを登録してください。`;
  }
  if (!requiresLocalModel) {
    return null;
  }
  if (isModelDownloaded === undefined) {
    return "Whisperモデル状態を確認中です。";
  }
  if (!isModelDownloaded) {
    return "文字起こし開始には、Whisperモデルのダウンロードが必要です。";
  }
  return null;
}

function getMeetingStartBlockedReason(
  isMeetingActive: boolean,
  requiresLocalModel: boolean,
  isModelDownloaded: boolean | undefined,
  modelDownloadedError: unknown,
  externalApiProvider: string | null,
  hasExternalApiKey: boolean | undefined,
  externalApiKeyError: unknown,
): string | null {
  if (isMeetingActive) return null;
  if (modelDownloadedError) return null;
  if (externalApiKeyError && externalApiProvider) {
    return `${externalApiProvider} API キー状態を確認できません。`;
  }
  if (externalApiProvider && hasExternalApiKey === undefined) {
    return `${externalApiProvider} API キー状態を確認中です。`;
  }
  if (externalApiProvider && !hasExternalApiKey) {
    return `会議開始には、設定画面で ${externalApiProvider} API キーを登録してください。`;
  }
  if (!requiresLocalModel) return null;
  if (isModelDownloaded === undefined) {
    return "会議開始に必要なWhisperモデル状態を確認中です。";
  }
  if (!isModelDownloaded) {
    return "会議開始には、Whisperモデルのダウンロードが必要です。";
  }
  return null;
}

function getAudioSourceStatusLabel(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string {
  if (isMicRecording && isSystemAudioRecording) {
    return "自分 / 相手側";
  }
  if (isMicRecording) {
    return "自分のみ";
  }
  if (isSystemAudioRecording) {
    return "相手側のみ";
  }
  return "なし";
}

function getAudioSourceStatusAriaText(
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string {
  if (isMicRecording && isSystemAudioRecording) {
    return "自分と相手側を取得中";
  }
  if (isMicRecording) {
    return "自分のみ録音中、相手側は未取得";
  }
  if (isSystemAudioRecording) {
    return "相手側のみ取得中、自分は未録音";
  }
  return "音声ソースなし";
}

function getAudioSourceNotice(
  isVisible: boolean,
  isAudioCaptureOperationPending: boolean,
  isMicRecording: boolean,
  isSystemAudioRecording: boolean,
): string | null {
  if (
    !isVisible ||
    isAudioCaptureOperationPending ||
    (isMicRecording && isSystemAudioRecording)
  ) {
    return null;
  }
  if (isMicRecording) {
    return "相手側トラックは未取得です。相手側の発話は記録されません。";
  }
  if (isSystemAudioRecording) {
    return "自分トラックは未録音です。自分の発話は記録されません。";
  }
  return "音声ソース未開始です。自分 / 相手側トラックは記録されません。";
}

function getAudioSourceStatusPillClass(statusLabel: string): string {
  if (statusLabel === "自分 / 相手側") {
    return "meeting-status-pill-active";
  }
  if (statusLabel === "なし") {
    return "meeting-status-pill-idle";
  }
  return "meeting-status-pill-neutral";
}

function getRequiresLocalModel(engine: TranscriptionEngineType | undefined): boolean {
  return !engine || engine === "whisper";
}

function getExternalApiProvider(
  engine: TranscriptionEngineType | undefined,
): "OpenAI" | "ElevenLabs" | null {
  if (engine === "openAIRealtime") {
    return "OpenAI";
  }
  if (engine === "elevenLabsRealtime") {
    return "ElevenLabs";
  }
  return null;
}

function getAiTransmissionStatusLabel(
  engine: TranscriptionEngineType | undefined,
): string {
  if (!engine) {
    return "確認中";
  }
  if (engine === "openAIRealtime") {
    return "OpenAIへ送信";
  }
  if (engine === "elevenLabsRealtime") {
    return "ElevenLabsへ送信";
  }
  return "なし";
}

function getAiTransmissionStatusPillClass(statusLabel: string): string {
  if (statusLabel === "OpenAIへ送信" || statusLabel === "ElevenLabsへ送信") {
    return "meeting-status-pill-active";
  }
  if (statusLabel === "確認失敗") {
    return "meeting-status-pill-error";
  }
  if (statusLabel === "なし") {
    return "meeting-status-pill-idle";
  }
  return "meeting-status-pill-neutral";
}

function getEngineStatusLabel(
  engine: TranscriptionEngineType | undefined,
): string {
  if (!engine) {
    return "確認中";
  }
  if (engine === "appleSpeech") {
    return "Apple Speech・端末内";
  }
  if (engine === "openAIRealtime") {
    return "OpenAI・送信";
  }
  if (engine === "elevenLabsRealtime") {
    return "ElevenLabs・送信";
  }
  return "Whisper・端末内";
}

function getEngineStatusPillClass(statusLabel: string): string {
  if (statusLabel === "確認失敗") {
    return "meeting-status-pill-error";
  }
  if (statusLabel === "確認中") {
    return "meeting-status-pill-neutral";
  }
  return "meeting-status-pill-active";
}

function getExternalApiKeyStatusLabel(
  externalApiProvider: string | null,
  hasExternalApiKey: boolean | undefined,
  externalApiKeyError: unknown,
): string | null {
  if (!externalApiProvider) {
    return null;
  }
  if (externalApiKeyError) {
    return "確認失敗";
  }
  if (hasExternalApiKey === undefined) {
    return "確認中";
  }
  return hasExternalApiKey ? "登録済み" : "未設定";
}

function getExternalApiKeyStatusPillClass(statusLabel: string | null): string {
  if (statusLabel === "登録済み") {
    return "meeting-status-pill-active";
  }
  if (statusLabel === "確認失敗") {
    return "meeting-status-pill-error";
  }
  if (statusLabel === "未設定") {
    return "meeting-status-pill-idle";
  }
  return "meeting-status-pill-neutral";
}

function sanitizeAudioLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.max(0, Math.min(1, level));
}

export function TranscriptView() {
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [isSystemAudioRecording, setIsSystemAudioRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isMicOperationPending, setIsMicOperationPending] = useState(false);
  const [isSystemAudioOperationPending, setIsSystemAudioOperationPending] =
    useState(false);
  const [isMeetingOperationPending, setIsMeetingOperationPending] =
    useState(false);
  const [isTranscriptionOperationPending, setIsTranscriptionOperationPending] =
    useState(false);
  const audioOperationPendingRef = useRef(false);
  const [micLevel, setMicLevel] = useState(0);
  const [systemAudioLevel, setSystemAudioLevel] = useState(0);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("small");
  const hasSyncedSettingsModelRef = useRef(false);
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
    isFetching: isFetchingDevices,
    refetch: refetchDevices,
  } = useQuery<AudioDevice[]>({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<AudioDevice[]>("list_audio_devices"),
  });

  const { data: settings, error: settingsError } = useQuery<AppSettings>({
    queryKey: ["settings"],
    queryFn: () => invoke<AppSettings>("get_settings"),
  });

  useEffect(() => {
    if (!settings?.whisperModel || hasSyncedSettingsModelRef.current) {
      return;
    }
    setSelectedModel(settings.whisperModel);
    hasSyncedSettingsModelRef.current = true;
  }, [settings?.whisperModel]);

  const requiresLocalModel = getRequiresLocalModel(
    settings?.transcriptionEngine,
  );
  const externalApiProvider = getExternalApiProvider(
    settings?.transcriptionEngine,
  );
  const requiresOpenAIApiKey = externalApiProvider === "OpenAI";
  const requiresElevenLabsApiKey = externalApiProvider === "ElevenLabs";

  // Check if selected model is downloaded
  const { data: isModelDownloaded, error: modelDownloadedError } =
    useQuery<boolean>({
      queryKey: ["modelDownloaded", selectedModel],
      queryFn: () =>
        invoke<boolean>("is_model_downloaded", { modelName: selectedModel }),
      enabled: requiresLocalModel && !!selectedModel,
    });

  const {
    data: hasOpenAIApiKey,
    error: openAIApiKeyError,
  } = useQuery<boolean>({
    queryKey: ["openaiApiKey", "has"],
    queryFn: () => invoke<boolean>("has_openai_api_key"),
    enabled: requiresOpenAIApiKey,
  });

  const {
    data: hasElevenLabsApiKey,
    error: elevenLabsApiKeyError,
  } = useQuery<boolean>({
    queryKey: ["elevenlabsApiKey", "has"],
    queryFn: () => invoke<boolean>("has_elevenlabs_api_key"),
    enabled: requiresElevenLabsApiKey,
  });

  // Route audio-level events by source
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<AudioLevelPayload>("audio-level", (event) => {
      if (disposed) {
        return;
      }
      const level = sanitizeAudioLevel(event.payload.level);
      if (event.payload.source === "microphone") {
        setMicLevel(level);
      } else if (event.payload.source === "system_audio") {
        setSystemAudioLevel(level);
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
    if (isMeetingOperationPending || audioOperationPendingRef.current) {
      return;
    }
    audioOperationPendingRef.current = true;
    setIsMeetingOperationPending(true);
    try {
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
      setLastSavedPath(null);
      setMeetingError(null);
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
    } finally {
      audioOperationPendingRef.current = false;
      setIsMeetingOperationPending(false);
    }
  }, [
    isMeetingOperationPending,
    isMeetingActive,
    isTranscribing,
    isMicRecording,
    isSystemAudioRecording,
    selectedDeviceId,
    selectedModel,
  ]);

  const handleToggleMicRecording = useCallback(async () => {
    if (
      isMicOperationPending ||
      isSystemAudioOperationPending ||
      isMeetingOperationPending ||
      isTranscriptionOperationPending ||
      audioOperationPendingRef.current
    ) {
      return;
    }
    audioOperationPendingRef.current = true;
    setIsMicOperationPending(true);
    setMeetingError((currentError) =>
      clearRelatedMeetingError(currentError, MIC_RECORDING_ERROR_PREFIX),
    );
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
    } finally {
      audioOperationPendingRef.current = false;
      setIsMicOperationPending(false);
    }
  }, [
    isMicOperationPending,
    isSystemAudioOperationPending,
    isMeetingOperationPending,
    isTranscriptionOperationPending,
    isMicRecording,
    isSystemAudioRecording,
    isTranscribing,
    selectedDeviceId,
  ]);

  const handleToggleSystemAudio = useCallback(async () => {
    if (
      isSystemAudioOperationPending ||
      isMicOperationPending ||
      isMeetingOperationPending ||
      isTranscriptionOperationPending ||
      audioOperationPendingRef.current
    ) {
      return;
    }
    audioOperationPendingRef.current = true;
    setIsSystemAudioOperationPending(true);
    setMeetingError((currentError) =>
      clearRelatedMeetingError(currentError, SYSTEM_AUDIO_ERROR_PREFIX),
    );
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
      console.error("相手側音声の取得操作に失敗しました:", toErrorMessage(e));
      setMeetingError(msg);
    } finally {
      audioOperationPendingRef.current = false;
      setIsSystemAudioOperationPending(false);
    }
  }, [
    isSystemAudioOperationPending,
    isMicOperationPending,
    isMeetingOperationPending,
    isTranscriptionOperationPending,
    isSystemAudioRecording,
    isMicRecording,
    isTranscribing,
  ]);

  const handleToggleTranscription = useCallback(async () => {
    if (
      isTranscriptionOperationPending ||
      isMicOperationPending ||
      isSystemAudioOperationPending ||
      isMeetingOperationPending ||
      audioOperationPendingRef.current
    ) {
      return;
    }
    audioOperationPendingRef.current = true;
    setIsTranscriptionOperationPending(true);
    setMeetingError((currentError) =>
      clearRelatedMeetingError(currentError, TRANSCRIPTION_ERROR_PREFIX),
    );
    let micRestartPending = false;
    let systemAudioRestartPending = false;
    try {
      if (isTranscribing) {
        await stopTranscriptionFromUiState();
        setIsTranscribing(false);
      } else {
        if (isMicRecording) {
          micRestartPending = true;
          if (selectedDeviceId) {
            await invoke("start_recording", { deviceId: selectedDeviceId });
          } else {
            await invoke("start_recording");
          }
          micRestartPending = false;
          setMicLevel(0);
        }
        if (isSystemAudioRecording) {
          systemAudioRestartPending = true;
          await invoke("start_system_audio");
          systemAudioRestartPending = false;
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
      if (micRestartPending) {
        setIsMicRecording(false);
        setMicLevel(0);
      }
      if (systemAudioRestartPending) {
        setIsSystemAudioRecording(false);
        setSystemAudioLevel(0);
      }
      const msg = formatOperationError(TRANSCRIPTION_ERROR_PREFIX, e);
      console.error("文字起こし操作に失敗しました:", toErrorMessage(e));
      setMeetingError(msg);
    } finally {
      audioOperationPendingRef.current = false;
      setIsTranscriptionOperationPending(false);
    }
  }, [
    isTranscriptionOperationPending,
    isMicOperationPending,
    isSystemAudioOperationPending,
    isMeetingOperationPending,
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

  const modelDownloadedErrorForUi = requiresLocalModel
    ? modelDownloadedError
    : null;
  const externalApiKeyErrorForUi =
    externalApiProvider === "OpenAI"
      ? openAIApiKeyError
      : externalApiProvider === "ElevenLabs"
        ? elevenLabsApiKeyError
        : null;
  const hasExternalApiKey =
    externalApiProvider === "OpenAI"
      ? hasOpenAIApiKey
      : externalApiProvider === "ElevenLabs"
        ? hasElevenLabsApiKey
        : undefined;
  const isTranscriptionEngineReady =
    (!requiresLocalModel || isModelDownloaded === true) &&
    (!externalApiProvider || hasExternalApiKey === true) &&
    !externalApiKeyErrorForUi;
  const canStartTranscription =
    isAnySourceRecording && isTranscriptionEngineReady && !isTranscribing;

  const canStartMeeting = isTranscriptionEngineReady && !isMeetingActive;
  const meetingStartBlockedReason = getMeetingStartBlockedReason(
    isMeetingActive,
    requiresLocalModel,
    isModelDownloaded,
    modelDownloadedErrorForUi,
    externalApiProvider,
    hasExternalApiKey,
    externalApiKeyErrorForUi,
  );
  const isAudioSourceOperationPending =
    isMicOperationPending ||
    isSystemAudioOperationPending ||
    isMeetingOperationPending ||
    isTranscriptionOperationPending;
  const isAudioCaptureOperationPending =
    isMicOperationPending ||
    isSystemAudioOperationPending ||
    isMeetingOperationPending;
  const isMicSourceOperationPending =
    isMicOperationPending || isMeetingOperationPending;
  const isSystemAudioSourceOperationPending =
    isSystemAudioOperationPending || isMeetingOperationPending;

  const transcriptionSourceStatus = getTranscriptionSourceStatus(
    isTranscribing,
    isMicRecording,
    isSystemAudioRecording,
  );
  const transcriptionSourceStatusIsWarning =
    isTranscribing && !(isMicRecording && isSystemAudioRecording);
  const transcriptionStartBlockedReason = getTranscriptionStartBlockedReason(
    isTranscribing,
    isAnySourceRecording,
    requiresLocalModel,
    isModelDownloaded,
    modelDownloadedErrorForUi,
    externalApiProvider,
    hasExternalApiKey,
    externalApiKeyErrorForUi,
  );
  const audioSourceStatusLabel = getAudioSourceStatusLabel(
    isMicRecording,
    isSystemAudioRecording,
  );
  const audioSourceStatusAriaText = getAudioSourceStatusAriaText(
    isMicRecording,
    isSystemAudioRecording,
  );
  const audioSourceStatusDisplayLabel = isAudioCaptureOperationPending
    ? "処理中"
    : audioSourceStatusLabel;
  const audioSourceStatusDisplayAriaText = isAudioCaptureOperationPending
    ? "音声ソースを処理中"
    : audioSourceStatusAriaText;
  const audioSourceStatusClass = isAudioCaptureOperationPending
    ? "meeting-status-pill-neutral"
    : getAudioSourceStatusPillClass(audioSourceStatusLabel);
  const audioSourceNotice = getAudioSourceNotice(
    isMeetingActive || isTranscribing,
    isAudioCaptureOperationPending,
    isMicRecording,
    isSystemAudioRecording,
  );
  const aiTransmissionStatusLabel = settingsError
    ? "確認失敗"
    : getAiTransmissionStatusLabel(settings?.transcriptionEngine);
  const engineStatusLabel = settingsError
    ? "確認失敗"
    : getEngineStatusLabel(settings?.transcriptionEngine);
  const externalApiKeyStatusLabel = getExternalApiKeyStatusLabel(
    externalApiProvider,
    hasExternalApiKey,
    externalApiKeyErrorForUi,
  );
  const externalApiKeyStatusDisplayLabel =
    externalApiProvider && externalApiKeyStatusLabel
      ? `${externalApiProvider}キー ${externalApiKeyStatusLabel}`
      : null;
  const externalApiKeyStatusAriaLabel =
    externalApiProvider && externalApiKeyStatusLabel
      ? `${externalApiProvider} APIキー: ${externalApiKeyStatusLabel}`
      : null;
  const meetingRecordingStatusLabel = isMeetingOperationPending
    ? "処理中"
    : isMeetingActive
      ? "記録中"
      : "待機中";
  const meetingRecordingStatusClass = isMeetingOperationPending
    ? "meeting-status-pill-neutral"
    : isMeetingActive
      ? "meeting-status-pill-active"
      : "meeting-status-pill-idle";
  const transcriptionStatusLabel = isTranscriptionOperationPending
    ? "処理中"
    : isTranscribing
      ? "文字起こし中"
      : "文字起こし停止";
  const transcriptionStatusClass = isTranscriptionOperationPending
    ? "meeting-status-pill-neutral"
    : isTranscribing
      ? "meeting-status-pill-active"
      : "meeting-status-pill-idle";
  const meetingStatusAriaLabel = [
    "会議記録状態",
    meetingRecordingStatusLabel,
    transcriptionStatusLabel,
    `音声 ${audioSourceStatusDisplayAriaText}`,
    `エンジン ${engineStatusLabel}`,
    `外部送信 ${aiTransmissionStatusLabel}`,
    externalApiKeyStatusAriaLabel,
  ]
    .filter(Boolean)
    .join("、");
  const meetingButtonLabel = isMeetingOperationPending
    ? "会議記録を処理中"
    : isMeetingActive
      ? "会議記録を終了"
      : "会議記録を開始";
  const transcriptViewLabel = `${meetingStatusAriaLabel}、文字起こしログ ${segments.length} 件`;
  const lastSavedFileName = lastSavedPath ? getFileName(lastSavedPath) : null;
  const modelDownloadedErrorMessage = modelDownloadedErrorForUi
    ? toErrorMessage(modelDownloadedErrorForUi)
    : "";
  const settingsErrorMessage = settingsError ? toErrorMessage(settingsError) : "";
  const externalApiKeyErrorMessage = externalApiKeyErrorForUi
    ? toErrorMessage(externalApiKeyErrorForUi)
    : "";

  return (
    <div
      className="transcript-view"
      aria-busy={isAudioSourceOperationPending}
      aria-label={transcriptViewLabel}
      title={transcriptViewLabel}
    >
      <PermissionBanner />

      {/* 会議ボタン */}
      <div className="meeting-control">
        <button
          type="button"
          className={`meeting-btn ${isMeetingActive ? "meeting-btn-active" : ""}`}
          onClick={handleToggleMeeting}
          disabled={
            isMeetingOperationPending || (!canStartMeeting && !isMeetingActive)
          }
          aria-label={meetingButtonLabel}
          title={meetingButtonLabel}
          aria-describedby={
            meetingStartBlockedReason ? MEETING_START_BLOCKED_REASON_ID : undefined
          }
        >
          <span
            className={`rec-indicator ${isMeetingActive ? "rec-indicator-active" : ""}`}
            aria-hidden="true"
          />
          {isMeetingOperationPending
            ? "処理中..."
            : isMeetingActive
              ? "会議を終了"
              : "会議を開始"}
        </button>
        {isMeetingActive && meetingStartTime && (
          <span
            className="meeting-timer"
            aria-label={`会議経過時間 ${formatElapsedTime(elapsedTime)}`}
            title={`会議経過時間 ${formatElapsedTime(elapsedTime)}`}
          >
            {formatElapsedTime(elapsedTime)}
          </span>
        )}
        <div
          className="meeting-status-strip"
          role="status"
          aria-busy={isAudioSourceOperationPending}
          aria-live="polite"
          aria-atomic="true"
          aria-label={meetingStatusAriaLabel}
          title={meetingStatusAriaLabel}
        >
          <span
            className={`meeting-status-pill ${meetingRecordingStatusClass}`}
            aria-label={`会議記録: ${meetingRecordingStatusLabel}`}
            title={`会議記録: ${meetingRecordingStatusLabel}`}
          >
            {meetingRecordingStatusLabel}
          </span>
          <span
            className={`meeting-status-pill ${transcriptionStatusClass}`}
            aria-label={`文字起こし: ${transcriptionStatusLabel}`}
            title={`文字起こし: ${transcriptionStatusLabel}`}
          >
            {transcriptionStatusLabel}
          </span>
          <span
            className={`meeting-status-pill ${audioSourceStatusClass}`}
            aria-label={`音声ソース: ${audioSourceStatusDisplayAriaText}`}
            title={`音声ソース: ${audioSourceStatusDisplayAriaText}`}
          >
            音声 {audioSourceStatusDisplayLabel}
          </span>
          <span
            className={`meeting-status-pill ${getEngineStatusPillClass(engineStatusLabel)}`}
            aria-label={`文字起こしエンジン: ${engineStatusLabel}`}
            title={`文字起こしエンジン: ${engineStatusLabel}`}
          >
            エンジン {engineStatusLabel}
          </span>
          <span
            className={`meeting-status-pill ${getAiTransmissionStatusPillClass(aiTransmissionStatusLabel)}`}
            aria-label={`外部送信: ${aiTransmissionStatusLabel}`}
            title={`外部送信: ${aiTransmissionStatusLabel}`}
          >
            外部送信 {aiTransmissionStatusLabel}
          </span>
          {externalApiKeyStatusLabel && externalApiKeyStatusDisplayLabel && (
            <span
              className={`meeting-status-pill ${getExternalApiKeyStatusPillClass(externalApiKeyStatusLabel)}`}
              aria-label={externalApiKeyStatusAriaLabel ?? undefined}
              title={externalApiKeyStatusAriaLabel ?? undefined}
            >
              {externalApiKeyStatusDisplayLabel}
            </span>
          )}
        </div>
        {audioSourceNotice && (
          <p
            className="meeting-source-notice"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`音声ソース注意: ${audioSourceNotice}`}
            title={`音声ソース注意: ${audioSourceNotice}`}
          >
            {audioSourceNotice}
          </p>
        )}
        {meetingError && (
          <div
            className="meeting-error meeting-alert meeting-error-dismissible"
            role="alert"
            aria-label={`会議記録エラー: ${meetingError}`}
            title={`会議記録エラー: ${meetingError}`}
          >
            <span>{meetingError}</span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => setMeetingError(null)}
              aria-label="会議記録エラーを閉じる"
              title="会議記録エラーを閉じる"
            >
              閉じる
            </button>
          </div>
        )}
        {modelDownloadedErrorForUi && (
          <p
            className="meeting-error meeting-alert"
            role="alert"
            aria-label={`Whisperモデル状態エラー: ${modelDownloadedErrorMessage}`}
            title={`Whisperモデル状態エラー: ${modelDownloadedErrorMessage}`}
          >
            Whisperモデル状態の確認に失敗しました: {modelDownloadedErrorMessage}
          </p>
        )}
        {settingsError && (
          <p
            className="meeting-error meeting-alert"
            role="alert"
            aria-label={`文字起こし設定エラー: ${settingsErrorMessage}`}
            title={`文字起こし設定エラー: ${settingsErrorMessage}`}
          >
            文字起こし設定の取得に失敗しました: {settingsErrorMessage}
          </p>
        )}
        {externalApiKeyErrorForUi && externalApiProvider && (
          <p
            className="meeting-error meeting-alert"
            role="alert"
            aria-label={`${externalApiProvider} API キー状態エラー: ${externalApiKeyErrorMessage}`}
            title={`${externalApiProvider} API キー状態エラー: ${externalApiKeyErrorMessage}`}
          >
            {externalApiProvider} API キー状態の確認に失敗しました:{" "}
            {externalApiKeyErrorMessage}
          </p>
        )}
        {meetingStartBlockedReason && (
          <p
            id={MEETING_START_BLOCKED_REASON_ID}
            className="meeting-error"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`会議開始不可理由: ${meetingStartBlockedReason}`}
            title={`会議開始不可理由: ${meetingStartBlockedReason}`}
          >
            {meetingStartBlockedReason}
          </p>
        )}
        {audioLevelListenerError && (
          <p
            className="meeting-error meeting-alert"
            role="alert"
            aria-label={`音量レベル監視エラー: ${audioLevelListenerError}`}
            title={`音量レベル監視エラー: ${audioLevelListenerError}`}
          >
            {audioLevelListenerError}
          </p>
        )}
        {lastSavedPath && lastSavedFileName && (
          <p
            className="meeting-saved-path"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`会議セッションを保存しました: ${lastSavedFileName}、保存先 ${lastSavedPath}`}
            title={`会議セッションを保存しました: ${lastSavedPath}`}
          >
            保存しました: {lastSavedFileName}
          </p>
        )}
      </div>

      <div className="section-divider" />

      <MicrophoneSection
        isMicRecording={isMicRecording}
        micLevel={micLevel}
        selectedDeviceId={selectedDeviceId}
        audioDevices={devices}
        audioDevicesError={devicesError}
        isReloadingAudioDevices={isFetchingDevices}
        isOperationPending={isMicSourceOperationPending}
        isControlDisabled={isAudioSourceOperationPending}
        onDeviceChange={setSelectedDeviceId}
        onRetryDevices={() => refetchDevices()}
        onToggleRecording={handleToggleMicRecording}
      />

      <SystemAudioSection
        isSystemAudioRecording={isSystemAudioRecording}
        systemAudioLevel={systemAudioLevel}
        isOperationPending={isSystemAudioSourceOperationPending}
        isControlDisabled={isAudioSourceOperationPending}
        onToggleSystemAudio={handleToggleSystemAudio}
      />

      <div className="section-divider" />

      <TranscriptionControls
        isTranscribing={isTranscribing}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        showModelSelector={requiresLocalModel}
        onToggleTranscription={handleToggleTranscription}
        canStartTranscription={canStartTranscription}
        isTranscriptionOperationPending={isTranscriptionOperationPending}
        startBlockedReason={transcriptionStartBlockedReason}
        sourceStatusText={transcriptionSourceStatus}
        sourceStatusIsWarning={transcriptionSourceStatusIsWarning}
        segmentsCount={segments.length}
        onClearTranscript={handleClearTranscript}
      />

      <TranscriptDisplay segments={segments} onNewSegment={handleNewSegment} />
    </div>
  );
}
