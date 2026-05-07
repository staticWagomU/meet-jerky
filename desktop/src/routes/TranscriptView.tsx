import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  CircleDot,
  Globe,
  History,
  Mic,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Volume2,
} from "lucide-react";
import type {
  AppSettings,
  AudioDevice,
  TranscriptSegment,
} from "../types";
import { MicrophoneSection } from "../components/MicrophoneSection";
import { SystemAudioSection } from "../components/SystemAudioSection";
import { TranscriptionControls } from "../components/TranscriptionControls";
import { TranscriptDisplay } from "../components/TranscriptDisplay";
import {
  startSession,
  finalizeAndSaveSession,
  discardSession,
} from "../hooks/useSession";
import { usePermissions } from "../hooks/usePermissions";
import { useSessionList } from "../hooks/useSessionList";
import {
  clearPendingMeetingStartRequest,
  hasPendingMeetingStartRequest as readPendingMeetingStartRequest,
  MEETING_START_REQUEST_EVENT,
} from "../utils/meetingStartRequest";
import { toErrorMessage } from "../utils/errorMessage";
import {
  formatOperationError,
  getFileName,
  getCompactSessionTitle,
  getRecentSessionMeta,
  formatElapsedTime,
} from "../utils/transcriptViewFormatters";
import {
  getAudioLevelPayloadIssue,
  isAudioLevelPayload,
} from "../utils/audioLevelPayload";
import {
  getAudioDropCountPayloadIssue,
  isAudioDropCountPayload,
} from "../utils/audioDropCountPayload";
import {
  AUDIO_DROP_COUNT_EVENT,
  AUDIO_LEVEL_EVENT,
  SYSTEM_AUDIO_FORMAT_WARNING_EVENT,
} from "../utils/audioEvents";
import { getPopoverLevelBars, sanitizeAudioLevel } from "../utils/audioLevelHelpers";
import {
  getAudioSourceNotice,
  getAudioSourceStatusAriaText,
  getAudioSourceStatusLabel,
  getAudioSourceStatusPillClass,
} from "../utils/audioSourceHelpers";
import {
  getEngineStatusDisplayLabel,
  getEngineStatusLabel,
  getEngineStatusPillClass,
} from "../utils/engineStatusHelpers";
import {
  getExternalApiKeyStatusAriaLabel,
  getExternalApiKeyStatusLabel,
  getExternalApiKeyStatusPillClass,
} from "../utils/externalApiKeyHelpers";
import { getPermissionStatusLabel, getPermissionRowClassName } from "../utils/permissionStatusHelpers";
import { STATUS_CHECKING_LABEL, STATUS_ENDING_LABEL, STATUS_RECORDING_LABEL, STATUS_STARTING_LABEL, STATUS_UNCHECKABLE_LABEL } from "../utils/statusLabels";
import { getMicTrackStatusAriaLabel, getSystemAudioTrackStatusAriaLabel } from "../utils/trackStatusAriaLabels";
import {
  getAiTransmissionStatusAriaLabel,
  getAiTransmissionStatusLabel,
  getAiTransmissionStatusPillClass,
} from "../utils/aiTransmissionHelpers";
import {
  getExternalApiProvider,
  getRequiresLocalModel,
} from "../utils/transcriptionEngineHelpers";
import {
  buildLiveCaptionStatusFromLabels,
  LIVE_CAPTION_STATUS_EVENT,
  writeStoredLiveCaptionStatus,
} from "../utils/liveCaptionStatus";
import { RING_LIGHT_MODE_EVENT } from "../utils/ringLight";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";
import {
  CONTROL_CHARACTER_PATTERN,
  getTranscriptionErrorPayloadIssue,
  isTranscriptionErrorPayload,
} from "../utils/transcriptSegment";
import { normalizeSystemAudioFormatWarningPayload } from "../utils/systemAudioFormatWarningPayload";
import { TRANSCRIPTION_ERROR_EVENT } from "../utils/transcriptionEvents";
import {
  MACOS_ACCESSIBILITY_PRIVACY_URL,
  MACOS_MICROPHONE_PRIVACY_URL,
  MACOS_SCREEN_RECORDING_PRIVACY_URL,
  OPEN_ACCESSIBILITY_PRIVACY_LABEL,
  OPEN_MICROPHONE_PRIVACY_LABEL,
  OPEN_SCREEN_RECORDING_PRIVACY_LABEL,
} from "../utils/macosPrivacySettings";
import {
  APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON,
  getTranscriptionSourceArg,
  getTranscriptionSourceStatus,
  getTranscriptionSourceStatusAriaText,
  getTranscriptionStartBlockedReason,
} from "../utils/transcriptionSourceHelpers";
import { getMeetingStartBlockedReason } from "../utils/meetingStartHelpers";

const MIC_RECORDING_ERROR_PREFIX = "マイク録音操作に失敗しました:";
const SYSTEM_AUDIO_ERROR_PREFIX = "相手側音声の取得操作に失敗しました:";
const TRANSCRIPTION_ERROR_PREFIX = "文字起こし操作に失敗しました:";
const LIVE_CAPTION_STATUS_SAVE_ERROR_PREFIX =
  "ライブ字幕ステータスの保存に失敗しました:";
const LIVE_CAPTION_STATUS_SYNC_ERROR_PREFIX =
  "ライブ字幕ステータスの同期に失敗しました:";
const TRANSCRIPTION_START_ATTEMPTED_TRACK_STATUS_NOTICE =
  "録音トラックの状態は上部の自分/相手側ステータスで確認してください。";
const TRANSCRIPTION_NOT_RUNNING_MESSAGE = "文字起こしは実行されていません";
const MEETING_START_BLOCKED_REASON_ID = "meeting-start-blocked-reason";
const SYSTEM_AUDIO_FORMAT_WARNING_LISTENER_ERROR_PREFIX =
  "音声形式警告通知の受信開始に失敗しました:";
const UNKNOWN_AUDIO_SOURCE_LABEL_MAX_LENGTH = 80;
const UNKNOWN_AUDIO_SOURCE_UNDISPLAYABLE_LABEL = "表示できない値";
type SavedFileAction = "open" | "reveal" | null;

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

function getUnknownAudioSourceLabel(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("source" in value)) {
    return null;
  }
  const source = (value as { source: unknown }).source;
  if (source === "microphone" || source === "system_audio") {
    return null;
  }
  const label = (typeof source === "string" ? source : String(source)).trim();
  if (
    label.length === 0 ||
    label.length > UNKNOWN_AUDIO_SOURCE_LABEL_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(label)
  ) {
    return UNKNOWN_AUDIO_SOURCE_UNDISPLAYABLE_LABEL;
  }
  return label;
}

export function TranscriptView() {
  const queryClient = useQueryClient();
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [isSystemAudioRecording, setIsSystemAudioRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [hasTranscriptionErrorStopped, setHasTranscriptionErrorStopped] =
    useState(false);
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
  const ringLightVisibilityRequestIdRef = useRef(0);
  const ringLightDesiredVisibilityRef = useRef(false);

  // Session wiring state
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [savedFileActionError, setSavedFileActionError] = useState<
    string | null
  >(null);
  const [savedFileActionPending, setSavedFileActionPending] =
    useState<SavedFileAction>(null);
  const [audioLevelListenerError, setAudioLevelListenerError] = useState<
    string | null
  >(null);
  const [microphoneDropCountTotal, setMicrophoneDropCountTotal] = useState(0);
  const [systemAudioDropCountTotal, setSystemAudioDropCountTotal] = useState(0);
  const [audioDropCountListenerError, setAudioDropCountListenerError] =
    useState<string | null>(null);
  const [systemAudioFormatWarning, setSystemAudioFormatWarning] = useState<
    string | null
  >(null);
  const [hasPendingMeetingStartRequest, setHasPendingMeetingStartRequest] =
    useState(false);
  const [permissionSettingsOpenError, setPermissionSettingsOpenError] =
    useState<string | null>(null);
  const [hasSkippedFirstLaunch, setHasSkippedFirstLaunch] = useState(false);

  const {
    micPermission,
    micPermissionError,
    isFetchingMicPermission,
    screenPermission,
    screenPermissionError,
    isFetchingScreenPermission,
    isCheckingPermissions,
    refetchAll: refetchPermissions,
  } = usePermissions();

  const {
    data: recentSessions,
    isLoading: isLoadingRecentSessions,
    error: recentSessionsError,
  } = useSessionList();

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

  useEffect(() => {
    if (readPendingMeetingStartRequest()) {
      setHasPendingMeetingStartRequest(true);
    }
    let disposed = false;
    const unlistenPromise = listen(MEETING_START_REQUEST_EVENT, () => {
      if (!disposed) {
        setHasPendingMeetingStartRequest(true);
      }
    }).catch((e) => {
      if (!disposed) {
        const msg = toErrorMessage(e);
        console.error("録音開始要求の受信開始に失敗しました:", msg);
        setMeetingError(`録音開始要求の受信開始に失敗しました: ${msg}`);
      }
      return null;
    });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error("録音開始要求の受信解除に失敗しました:", toErrorMessage(e));
        });
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<unknown>(
      TRANSCRIPTION_ERROR_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        setIsTranscribing(false);
        setIsTranscriptionOperationPending(false);
        setHasTranscriptionErrorStopped(true);
        const payload = event.payload;
        if (!isTranscriptionErrorPayload(payload)) {
          const issue = getTranscriptionErrorPayloadIssue(payload);
          setMeetingError(
            `文字起こしは停止しましたが、エラー通知の形式が不正です。（理由: ${issue}）`,
          );
          return;
        }
        const trackLabel =
          payload.source === "microphone"
            ? SELF_TRACK_DEVICE_LABEL
            : payload.source === "system_audio"
              ? OTHER_TRACK_DEVICE_LABEL
              : null;
        setMeetingError(
          trackLabel
            ? `文字起こしが停止しました（${trackLabel}）: ${payload.error}`
            : `文字起こしが停止しました: ${payload.error}`,
        );
      },
    )
      .then((unlisten) => unlisten)
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("文字起こしエラー通知の受信開始に失敗しました:", msg);
          setMeetingError(
            `文字起こしエラー通知の受信開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "文字起こしエラー通知の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, []);

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
    const unlistenPromise = listen<unknown>(AUDIO_LEVEL_EVENT, (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (!isAudioLevelPayload(payload)) {
        const unknownSourceLabel = getUnknownAudioSourceLabel(payload);
        if (unknownSourceLabel !== null) {
          setAudioLevelListenerError(
            `音声レベル通知の未知の音声ソースです: ${unknownSourceLabel}`,
          );
          return;
        }
        setAudioLevelListenerError(
          `音声レベル通知の形式が不正です。（理由: ${getAudioLevelPayloadIssue(payload)}）`,
        );
        return;
      }
      setAudioLevelListenerError(null);
      const level = sanitizeAudioLevel(payload.level);
      if (payload.source === "microphone") {
        setMicLevel(level);
      } else if (payload.source === "system_audio") {
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

  // Route audio-drop-count events by source (cumulative)
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<unknown>(AUDIO_DROP_COUNT_EVENT, (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (!isAudioDropCountPayload(payload)) {
        const unknownSourceLabel = getUnknownAudioSourceLabel(payload);
        if (unknownSourceLabel !== null) {
          setAudioDropCountListenerError(
            `音声 drop 通知の未知の音声ソースです: ${unknownSourceLabel}`,
          );
          return;
        }
        setAudioDropCountListenerError(
          `音声 drop 通知の形式が不正です。（理由: ${getAudioDropCountPayloadIssue(payload)}）`,
        );
        return;
      }
      setAudioDropCountListenerError(null);
      console.warn(
        `[audio-drop-count] ${payload.source} で ${payload.dropped} sample 破棄`,
      );
      if (payload.source === "microphone") {
        setMicrophoneDropCountTotal((prev) => prev + payload.dropped);
      } else if (payload.source === "system_audio") {
        setSystemAudioDropCountTotal((prev) => prev + payload.dropped);
      }
    })
      .then((unlisten) => {
        if (!disposed) {
          setAudioDropCountListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("音声 drop 監視の開始に失敗しました:", msg);
          setAudioDropCountListenerError(
            `音声 drop 監視の開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error("音声 drop 監視の解除に失敗しました:", toErrorMessage(e));
        });
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<unknown>(
      SYSTEM_AUDIO_FORMAT_WARNING_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        setSystemAudioFormatWarning(
          normalizeSystemAudioFormatWarningPayload(event.payload),
        );
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setSystemAudioFormatWarning((current) =>
            current?.startsWith(SYSTEM_AUDIO_FORMAT_WARNING_LISTENER_ERROR_PREFIX)
              ? null
              : current,
          );
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("音声形式警告通知の受信開始に失敗しました:", msg);
          setSystemAudioFormatWarning(
            `${SYSTEM_AUDIO_FORMAT_WARNING_LISTENER_ERROR_PREFIX} ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "音声形式警告通知の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, []);

  const clearSystemAudioCaptureState = useCallback(() => {
    setIsSystemAudioRecording(false);
    setSystemAudioLevel(0);
    setSystemAudioDropCountTotal(0);
    setSystemAudioFormatWarning(null);
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
  const isRecordingOrTranscriptionVisible =
    isMeetingActive || isTranscribing || isAnySourceRecording;

  const handleOpenLastSavedFile = useCallback(async () => {
    if (!lastSavedPath || savedFileActionPending) {
      return;
    }
    setSavedFileActionPending("open");
    setSavedFileActionError(null);
    try {
      await openPath(lastSavedPath);
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("保存済み履歴ファイルを開けませんでした:", msg);
      setSavedFileActionError(`保存済み履歴ファイルを開けませんでした: ${msg}`);
    } finally {
      setSavedFileActionPending(null);
    }
  }, [lastSavedPath, savedFileActionPending]);

  const handleRevealLastSavedFile = useCallback(async () => {
    if (!lastSavedPath || savedFileActionPending) {
      return;
    }
    setSavedFileActionPending("reveal");
    setSavedFileActionError(null);
    try {
      await revealItemInDir(lastSavedPath);
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("保存済み履歴ファイルを Finder で表示できませんでした:", msg);
      setSavedFileActionError(
        `保存済み履歴ファイルを Finder で表示できませんでした: ${msg}`,
      );
    } finally {
      setSavedFileActionPending(null);
    }
  }, [lastSavedPath, savedFileActionPending]);

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
            setHasTranscriptionErrorStopped(false);
          }
          if (isMicRecording) {
            await invoke("stop_recording");
            setIsMicRecording(false);
            setMicLevel(0);
            setMicrophoneDropCountTotal(0);
          }
          if (isSystemAudioRecording) {
            await invoke("stop_system_audio");
            clearSystemAudioCaptureState();
          }
          setIsMeetingActive(false);
          setMeetingStartTime(null);
          setElapsedTime(0);
        } catch (e) {
          const msg = toErrorMessage(e);
          console.error("記録停止に失敗しました:", msg);
          setMeetingError(`記録停止に失敗しました: ${msg}`);
          return;
        }

        // 録音停止は完了している。finalize 失敗時はユーザーに通知するだけ。
        try {
          const savedPath = await finalizeAndSaveSession();
          setLastSavedPath(savedPath);
          void queryClient.invalidateQueries({ queryKey: ["sessionList"] });
          setMeetingError(null);
        } catch (e) {
          const msg = toErrorMessage(e);
          console.error("セッション保存に失敗しました:", msg);
          setMeetingError(`セッション保存に失敗しました: ${msg}`);
        }
        return;
      }

      // START: session 開始 → mic → system audio → transcription
      if (settings?.transcriptionEngine === "appleSpeech") {
        setMeetingError(
          `記録開始に失敗しました: ${APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON}`,
        );
        return;
      }
      setLastSavedPath(null);
      setSavedFileActionError(null);
      setMeetingError(null);
      setHasTranscriptionErrorStopped(false);
      setMicrophoneDropCountTotal(0);
      setSystemAudioDropCountTotal(0);
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
        setHasTranscriptionErrorStopped(false);

        const now = Date.now();
        setMeetingStartTime(now);
        setIsMeetingActive(true);
        setMeetingError(null);
        setLastSavedPath(null);
      } catch (e) {
        const msg = toErrorMessage(e);
        const rollbackErrors: string[] = [];
        console.error("記録開始に失敗しました:", msg);
        if (transcriptionStarted) {
          await invoke("stop_transcription").catch((rollbackError) => {
            const rollbackMsg = toErrorMessage(rollbackError);
            rollbackErrors.push(`文字起こし停止: ${rollbackMsg}`);
            console.error(
              "文字起こしロールバックに失敗しました:",
              rollbackMsg,
            );
          });
        }
        if (systemAudioStarted) {
          await invoke("stop_system_audio")
            .then(() => {
              clearSystemAudioCaptureState();
            })
            .catch((rollbackError) => {
              const rollbackMsg = toErrorMessage(rollbackError);
              rollbackErrors.push(`相手側音声停止: ${rollbackMsg}`);
              console.error(
                "システム音声ロールバックに失敗しました:",
                rollbackMsg,
              );
            });
        }
        if (micStarted) {
          await invoke("stop_recording")
            .then(() => {
              setMicrophoneDropCountTotal(0);
            })
            .catch((rollbackError) => {
              const rollbackMsg = toErrorMessage(rollbackError);
              rollbackErrors.push(`マイク録音停止: ${rollbackMsg}`);
              console.error(
                "マイク録音ロールバックに失敗しました:",
                rollbackMsg,
              );
            });
        }
        if (sessionStarted) {
          await discardSession().catch((rollbackError) => {
            const rollbackMsg = toErrorMessage(rollbackError);
            rollbackErrors.push(`セッション破棄: ${rollbackMsg}`);
            console.error(
              "セッション破棄に失敗しました:",
              rollbackMsg,
            );
          });
        }
        setIsTranscribing(false);
        clearSystemAudioCaptureState();
        setIsMicRecording(false);
        setMicLevel(0);
        setMicrophoneDropCountTotal(0);
        setIsMeetingActive(false);
        setMeetingStartTime(null);
        setElapsedTime(0);
        const rollbackErrorSummary =
          rollbackErrors.length > 0
            ? `。後片付けにも失敗しました: ${rollbackErrors.join(" / ")}`
            : "";
        setMeetingError(
          `記録開始に失敗しました: ${msg}${rollbackErrorSummary}`,
        );
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
    queryClient,
    selectedDeviceId,
    selectedModel,
    settings?.transcriptionEngine,
    clearSystemAudioCaptureState,
  ]);

  const startMicCapture = useCallback(async () => {
    if (selectedDeviceId) {
      await invoke("start_recording", { deviceId: selectedDeviceId });
      return;
    }
    await invoke("start_recording");
  }, [selectedDeviceId]);

  const restartTranscriptionForAudioSources = useCallback(
    async (nextMicRecording: boolean, nextSystemAudioRecording: boolean) => {
      const transcriptionSource = getTranscriptionSourceArg(
        nextMicRecording,
        nextSystemAudioRecording,
      );
      if (!transcriptionSource) {
        await stopTranscriptionFromUiState();
        setIsTranscribing(false);
        setHasTranscriptionErrorStopped(false);
        return;
      }
      if (
        settings?.transcriptionEngine === "appleSpeech" &&
        nextMicRecording &&
        nextSystemAudioRecording
      ) {
        throw new Error(APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON);
      }

      await stopTranscriptionFromUiState();
      setIsTranscribing(false);
      setHasTranscriptionErrorStopped(false);

      // Rust start_transcription takes each audio consumer, so restart capture to recreate consumers.
      if (nextMicRecording) {
        try {
          await startMicCapture();
          setIsMicRecording(true);
          setMicLevel(0);
        } catch (e) {
          // start_recording is stop-first; do not assume failed sources still have live capture.
          setIsMicRecording(false);
          setMicLevel(0);
          setMicrophoneDropCountTotal(0);
          setIsTranscribing(false);
          throw e;
        }
      }
      if (nextSystemAudioRecording) {
        try {
          await invoke("start_system_audio");
          setIsSystemAudioRecording(true);
          setSystemAudioLevel(0);
        } catch (e) {
          // start_system_audio is stop-first; do not assume failed sources still have live capture.
          clearSystemAudioCaptureState();
          setIsTranscribing(false);
          throw e;
        }
      }

      try {
        await invoke("start_transcription", {
          modelName: selectedModel,
          source: transcriptionSource,
        });
        setIsTranscribing(true);
        setHasTranscriptionErrorStopped(false);
      } catch (e) {
        setIsTranscribing(false);
        throw e;
      }
    },
    [
      selectedModel,
      settings?.transcriptionEngine,
      startMicCapture,
      clearSystemAudioCaptureState,
    ],
  );

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
        setMicrophoneDropCountTotal(0);
        // Keep transcription workers aligned with the remaining audio sources.
        if (isTranscribing) {
          if (isSystemAudioRecording) {
            await restartTranscriptionForAudioSources(false, true);
          } else {
            await stopTranscriptionFromUiState();
            setIsTranscribing(false);
            setHasTranscriptionErrorStopped(false);
          }
        }
      } else {
        if (
          isTranscribing &&
          isSystemAudioRecording &&
          settings?.transcriptionEngine === "appleSpeech"
        ) {
          throw new Error(APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON);
        }
        if (isTranscribing) {
          await restartTranscriptionForAudioSources(true, isSystemAudioRecording);
        } else {
          await startMicCapture();
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
    settings?.transcriptionEngine,
    startMicCapture,
    restartTranscriptionForAudioSources,
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
        clearSystemAudioCaptureState();
        // Keep transcription workers aligned with the remaining audio sources.
        if (isTranscribing) {
          if (isMicRecording) {
            await restartTranscriptionForAudioSources(true, false);
          } else {
            await stopTranscriptionFromUiState();
            setIsTranscribing(false);
            setHasTranscriptionErrorStopped(false);
          }
        }
      } else {
        if (
          isTranscribing &&
          isMicRecording &&
          settings?.transcriptionEngine === "appleSpeech"
        ) {
          throw new Error(APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON);
        }
        if (isTranscribing) {
          await restartTranscriptionForAudioSources(isMicRecording, true);
        } else {
          await invoke("start_system_audio");
        }
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
    settings?.transcriptionEngine,
    restartTranscriptionForAudioSources,
    clearSystemAudioCaptureState,
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
    let transcriptionStartAttempted = false;
    try {
      if (isTranscribing) {
        await stopTranscriptionFromUiState();
        setIsTranscribing(false);
        setHasTranscriptionErrorStopped(false);
      } else {
        setHasTranscriptionErrorStopped(false);
        if (
          settings?.transcriptionEngine === "appleSpeech" &&
          isMicRecording &&
          isSystemAudioRecording
        ) {
          throw new Error(APPLE_SPEECH_DUAL_SOURCE_BLOCKED_REASON);
        }
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
        transcriptionStartAttempted = true;
        await invoke("start_transcription", {
          modelName: selectedModel,
          source: transcriptionSource,
        });
        setIsTranscribing(true);
        setHasTranscriptionErrorStopped(false);
      }
      setMeetingError((currentError) =>
        clearRelatedMeetingError(currentError, TRANSCRIPTION_ERROR_PREFIX),
      );
    } catch (e) {
      if (micRestartPending) {
        setIsMicRecording(false);
        setMicLevel(0);
        setMicrophoneDropCountTotal(0);
      }
      if (systemAudioRestartPending) {
        clearSystemAudioCaptureState();
      }
      const msg = formatOperationError(TRANSCRIPTION_ERROR_PREFIX, e);
      console.error("文字起こし操作に失敗しました:", toErrorMessage(e));
      setMeetingError(
        transcriptionStartAttempted
          ? `${msg} ${TRANSCRIPTION_START_ATTEMPTED_TRACK_STATUS_NOTICE}`
          : msg,
      );
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
    settings?.transcriptionEngine,
    clearSystemAudioCaptureState,
  ]);

  const handleNewSegment = useCallback((segment: TranscriptSegment) => {
    setSegments((prev) => [...prev, segment]);
  }, []);

  const handleClearTranscript = useCallback(() => {
    setSegments([]);
  }, []);

  useEffect(() => {
    return () => {
      void invoke("set_live_caption_window_visible", { visible: false }).catch(
        (e) => {
          console.error(
            "ライブ字幕ウィンドウの非表示に失敗しました:",
            toErrorMessage(e),
          );
        },
      );
    };
  }, []);

  useEffect(() => {
    return () => {
      ringLightDesiredVisibilityRef.current = false;
      ringLightVisibilityRequestIdRef.current += 1;
      void invoke("set_ring_light_visible", { visible: false }).catch((e) => {
        console.error(
          "録音状態リングライトの終了時非表示に失敗しました:",
          toErrorMessage(e),
        );
      });
    };
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
  const isAppleSpeechDualSourceBlockedForTranscription =
    settings?.transcriptionEngine === "appleSpeech" &&
    isMicRecording &&
    isSystemAudioRecording;
  const isAppleSpeechDualSourceBlockedForMeeting =
    settings?.transcriptionEngine === "appleSpeech";
  const canStartTranscription =
    Boolean(settings) &&
    !settingsError &&
    isAnySourceRecording &&
    isTranscriptionEngineReady &&
    !isAppleSpeechDualSourceBlockedForTranscription &&
    !isTranscribing;

  const canStartMeeting =
    Boolean(settings) &&
    !settingsError &&
    isTranscriptionEngineReady &&
    !isAppleSpeechDualSourceBlockedForMeeting &&
    !isMeetingActive;
  const meetingStartBlockedReason = getMeetingStartBlockedReason(
    isMeetingActive,
    settings === undefined && !settingsError,
    settingsError,
    settings?.transcriptionEngine,
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
  const isAudioSourceOperationLocked =
    isAudioSourceOperationPending || audioOperationPendingRef.current;
  const shouldShowPendingMeetingStartNotice =
    hasPendingMeetingStartRequest &&
    !isMeetingActive &&
    (isAudioSourceOperationLocked ||
      (settings === undefined && !settingsError) ||
      Boolean(meetingStartBlockedReason?.includes(STATUS_CHECKING_LABEL)));
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
  const transcriptionSourceStatusAriaText =
    getTranscriptionSourceStatusAriaText(
      isTranscribing,
      isMicRecording,
      isSystemAudioRecording,
    );
  const transcriptionSourceStatusIsWarning =
    Boolean(transcriptionSourceStatus) &&
    !(isMicRecording && isSystemAudioRecording);
  const transcriptionStartBlockedReason = getTranscriptionStartBlockedReason(
    isTranscribing,
    settings === undefined && !settingsError,
    settingsError,
    isAnySourceRecording,
    isMicRecording,
    isSystemAudioRecording,
    settings?.transcriptionEngine,
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
    ? "切替中"
    : audioSourceStatusLabel;
  const audioSourceStatusDisplayAriaText = isAudioCaptureOperationPending
    ? "音声ソースを切替中"
    : audioSourceStatusAriaText;
  const audioSourceStatusClass = isAudioCaptureOperationPending
    ? "meeting-status-pill-neutral"
    : getAudioSourceStatusPillClass(isMicRecording, isSystemAudioRecording);
  const isMicInputWaiting =
    isMicRecording && Math.round(sanitizeAudioLevel(micLevel) * 100) === 0;
  const isSystemAudioInputWaiting =
    isSystemAudioRecording &&
    Math.round(sanitizeAudioLevel(systemAudioLevel) * 100) === 0;
  const micTrackStatusLabel = isMicSourceOperationPending
    ? "切替中"
    : isMicRecording
      ? isMicInputWaiting
        ? "録音中・入力待ち"
        : STATUS_RECORDING_LABEL
      : "未録音";
  const systemAudioTrackStatusLabel = isSystemAudioSourceOperationPending
    ? "切替中"
    : isSystemAudioRecording
      ? isSystemAudioInputWaiting
        ? "取得中・入力待ち"
        : "取得中"
      : "未取得";
  const audioSourceNotice = getAudioSourceNotice(
    isRecordingOrTranscriptionVisible,
    isAudioCaptureOperationPending,
    isMicRecording,
    isSystemAudioRecording,
    systemAudioFormatWarning,
  );
  const externalRealtimeRiskNotice = externalApiProvider
    ? isMeetingActive || isTranscribing
      ? `${externalApiProvider} Realtime へ音声を送信中です。プロバイダ側の利用量課金が発生する可能性があります。`
      : null
    : null;
  const aiTransmissionStatusLabel = settingsError
    ? STATUS_UNCHECKABLE_LABEL
    : getAiTransmissionStatusLabel(settings?.transcriptionEngine);
  const engineStatusLabel = settingsError
    ? STATUS_UNCHECKABLE_LABEL
    : getEngineStatusLabel(settings?.transcriptionEngine, {
        isModelDownloaded,
        modelDownloadedError: modelDownloadedErrorForUi,
      });
  const engineStatusDisplayLabel =
    getEngineStatusDisplayLabel(engineStatusLabel);
  const transcriptionStatusLabel = isTranscriptionOperationPending
    ? isTranscribing
      ? "停止中"
      : STATUS_STARTING_LABEL
    : isTranscribing
      ? "文字起こし中"
      : hasTranscriptionErrorStopped
        ? "エラー停止"
      : "停止中";

  useEffect(() => {
    const liveCaptionStatus = buildLiveCaptionStatusFromLabels(
      engineStatusDisplayLabel,
      aiTransmissionStatusLabel,
      {
        transcriptionStatusLabel,
        microphoneTrackLabel: micTrackStatusLabel,
        systemAudioTrackLabel: systemAudioTrackStatusLabel,
      },
    );
    const didStoreLiveCaptionStatus = writeStoredLiveCaptionStatus(
      liveCaptionStatus,
      (e) => {
        const msg = toErrorMessage(e);
        const errorMessage = `${LIVE_CAPTION_STATUS_SAVE_ERROR_PREFIX} ${msg}`;
        console.error(errorMessage);
        setMeetingError(errorMessage);
      },
    );
    if (didStoreLiveCaptionStatus) {
      setMeetingError((currentError) =>
        clearRelatedMeetingError(
          currentError,
          LIVE_CAPTION_STATUS_SAVE_ERROR_PREFIX,
        ),
      );
    }
    void emit(LIVE_CAPTION_STATUS_EVENT, liveCaptionStatus)
      .then(() => {
        setMeetingError((currentError) =>
          clearRelatedMeetingError(
            currentError,
            LIVE_CAPTION_STATUS_SYNC_ERROR_PREFIX,
          ),
        );
      })
      .catch((e) => {
        const msg = toErrorMessage(e);
        const errorMessage = `${LIVE_CAPTION_STATUS_SYNC_ERROR_PREFIX} ${msg}`;
        console.error(errorMessage);
        setMeetingError(errorMessage);
      });
  }, [
    aiTransmissionStatusLabel,
    engineStatusDisplayLabel,
    micTrackStatusLabel,
    systemAudioTrackStatusLabel,
    transcriptionStatusLabel,
  ]);

  useEffect(() => {
    void invoke("set_live_caption_window_visible", {
      visible: isRecordingOrTranscriptionVisible,
    }).catch((e) => {
      const msg = toErrorMessage(e);
      const errorMessage = `ライブ字幕ウィンドウの表示切替に失敗しました: ${msg}`;
      console.error(errorMessage);
      setMeetingError(errorMessage);
    });
  }, [isRecordingOrTranscriptionVisible]);

  useEffect(() => {
    const shouldShowRingLight = isRecordingOrTranscriptionVisible;
    ringLightDesiredVisibilityRef.current = shouldShowRingLight;
    const requestId = ringLightVisibilityRequestIdRef.current + 1;
    ringLightVisibilityRequestIdRef.current = requestId;
    const isCurrentRequest = () =>
      ringLightVisibilityRequestIdRef.current === requestId;
    void (async () => {
      try {
        if (shouldShowRingLight) {
          try {
            await emit(RING_LIGHT_MODE_EVENT, { mode: "soft" });
          } catch (modeSyncError) {
            const msg = toErrorMessage(modeSyncError);
            const errorMessage = `録音状態リングライトの表示モード同期に失敗しました: ${msg}`;
            console.error(errorMessage);
            if (isCurrentRequest()) {
              setMeetingError(errorMessage);
            }
          }
          if (!isCurrentRequest()) {
            return;
          }
          await invoke("set_ring_light_visible", { visible: true });
          if (!isCurrentRequest() && !ringLightDesiredVisibilityRef.current) {
            try {
              await invoke("set_ring_light_visible", { visible: false });
            } catch (rollbackError) {
              console.error(
                "古い録音状態リングライト表示要求の巻き戻しに失敗しました:",
                toErrorMessage(rollbackError),
              );
            }
          }
          return;
        }
        await invoke("set_ring_light_visible", { visible: false });
        if (!isCurrentRequest()) {
          return;
        }
      } catch (e) {
        const msg = toErrorMessage(e);
        const errorMessage = shouldShowRingLight
          ? `録音状態リングライトを表示できませんでした: ${msg}`
          : `録音状態リングライトを隠せませんでした: ${msg}`;
        console.error(errorMessage);
        if (!isCurrentRequest()) {
          return;
        }
        setMeetingError(errorMessage);
      }
    })();
  }, [isRecordingOrTranscriptionVisible]);

  const externalApiKeyStatusLabel = getExternalApiKeyStatusLabel(
    externalApiProvider,
    hasExternalApiKey,
    externalApiKeyErrorForUi,
  );
  const externalApiKeyStatusDisplayLabel =
    externalApiProvider && externalApiKeyStatusLabel
      ? `${externalApiProvider} キー${externalApiKeyStatusLabel}`
      : null;
  const shouldShowExternalApiKeyStatus =
    Boolean(externalApiKeyStatusLabel) &&
    externalApiKeyStatusLabel !== "登録済み";
  const externalApiKeyStatusAriaLabel = getExternalApiKeyStatusAriaLabel(
    externalApiProvider,
    externalApiKeyStatusLabel,
  );
  const meetingRecordingStatusLabel = isMeetingOperationPending
    ? isMeetingActive
      ? STATUS_ENDING_LABEL
      : STATUS_STARTING_LABEL
    : isMeetingActive
      ? STATUS_RECORDING_LABEL
      : "未録音";
  const meetingRecordingStatusClass = isMeetingOperationPending
    ? "meeting-status-pill-neutral"
    : isMeetingActive
      ? "meeting-status-pill-active"
      : "meeting-status-pill-idle";
  const transcriptionStatusClass = isTranscriptionOperationPending
    ? "meeting-status-pill-neutral"
    : isTranscribing
      ? "meeting-status-pill-active"
      : hasTranscriptionErrorStopped
        ? "meeting-status-pill-error"
      : "meeting-status-pill-idle";
  const canShowLiveCaptionWindow = isRecordingOrTranscriptionVisible;
  const showLiveCaptionWindowLabel = canShowLiveCaptionWindow
    ? "ライブ文字起こしウィンドウを表示または前面に戻す"
    : "録音または文字起こし中だけライブ文字起こしウィンドウを表示できます";
  const meetingStatusAriaLabel = [
    "記録状態",
    meetingRecordingStatusLabel,
    transcriptionStatusLabel,
    `音声 ${audioSourceStatusDisplayAriaText}`,
    getMicTrackStatusAriaLabel(micTrackStatusLabel),
    getSystemAudioTrackStatusAriaLabel(systemAudioTrackStatusLabel),
    `エンジン ${engineStatusLabel}`,
    getAiTransmissionStatusAriaLabel(aiTransmissionStatusLabel),
    externalApiKeyStatusAriaLabel,
  ]
    .filter(Boolean)
    .join("、");
  const isMeetingStatusBusy =
    isMeetingOperationPending ||
    isTranscriptionOperationPending ||
    isAudioSourceOperationPending;
  const meetingButtonLabel = isMeetingOperationPending
    ? isMeetingActive
      ? "録音と文字起こしの記録を終了中"
      : "録音と文字起こしの記録を開始中"
    : isMeetingActive
      ? "録音と文字起こしの記録を終了"
      : !canStartMeeting && meetingStartBlockedReason
        ? `録音と文字起こしの記録を開始できません: ${meetingStartBlockedReason}`
      : "録音と文字起こしの記録を開始";
  const transcriptViewLabel = `${meetingStatusAriaLabel}、文字起こしログ ${segments.length} 件`;
  const meetingPopoverTitle = isMeetingOperationPending
    ? isMeetingActive
      ? STATUS_ENDING_LABEL
      : STATUS_STARTING_LABEL
    : isMeetingActive
      ? "記録中"
      : "待機中";
  const meetingPopoverSubtitle =
    isMeetingActive && meetingStartTime
      ? `経過 ${formatElapsedTime(elapsedTime)}`
      : "記録準備";
  const meetingDetectionCardTitle = isMeetingActive
    ? "録音と文字起こしを記録中"
    : "会議検知と手動開始に対応";
  const meetingDetectionCardDetail = isMeetingActive
    ? "マイクとシステム音声の状態を表示中"
    : "ブラウザ URL / アプリ検知に対応。録音は開始操作後のみ";
  const meetingPopoverRecordingLabel = isMeetingOperationPending
    ? isMeetingActive
      ? STATUS_ENDING_LABEL
      : STATUS_STARTING_LABEL
    : meetingRecordingStatusLabel;
  const meetingFooterEndLabel = isMeetingActive
    ? meetingButtonLabel
    : "記録中のみ終了できます";
  const micPopoverSubtitle = isMicSourceOperationPending
    ? "自分の音声 · 切替中"
    : isMicRecording
      ? isMicInputWaiting
        ? "自分の音声 · 入力待ち"
        : "自分の音声 · 入力良好"
      : "自分の音声 · 未録音";
  const systemAudioPopoverSubtitle = isSystemAudioSourceOperationPending
    ? "相手側全体 · 切替中"
    : isSystemAudioRecording
      ? isSystemAudioInputWaiting
        ? "相手側全体 · 入力待ち"
        : "相手側全体 · 分離取得中"
      : "相手側全体 · 未取得";
  const micPopoverBars = getPopoverLevelBars(micLevel);
  const systemAudioPopoverBars = getPopoverLevelBars(systemAudioLevel);
  const lastSavedFileName = lastSavedPath ? getFileName(lastSavedPath) : null;
  const lastSavedOpenLabel = lastSavedFileName
    ? savedFileActionPending === "open"
      ? `保存済み履歴ファイルを macOS の既定アプリで開いています: ${lastSavedFileName}`
      : savedFileActionPending === "reveal"
        ? `保存済み履歴ファイルを Finder で表示中のため macOS の既定アプリで開けません: ${lastSavedFileName}`
        : `保存済み履歴ファイルを macOS の既定アプリで開く: ${lastSavedFileName}`
    : "保存済み履歴ファイルを macOS の既定アプリで開く";
  const lastSavedRevealLabel = lastSavedFileName
    ? savedFileActionPending === "reveal"
      ? `保存済み履歴ファイルを Finder で表示しています: ${lastSavedFileName}`
      : savedFileActionPending === "open"
        ? `保存済み履歴ファイルを開いているため Finder で表示できません: ${lastSavedFileName}`
        : `保存済み履歴ファイルを Finder で表示: ${lastSavedFileName}`
    : "保存済み履歴ファイルを Finder で表示";
  const lastSavedActionsLabel = lastSavedFileName
    ? `保存済み履歴ファイル操作: ${lastSavedFileName}、macOS の既定アプリで開く、または Finder で表示`
    : "保存済み履歴ファイル操作";
  const modelDownloadedErrorMessage = modelDownloadedErrorForUi
    ? toErrorMessage(modelDownloadedErrorForUi)
    : "";
  const settingsErrorMessage = settingsError ? toErrorMessage(settingsError) : "";
  const externalApiKeyErrorMessage = externalApiKeyErrorForUi
    ? toErrorMessage(externalApiKeyErrorForUi)
    : "";
  const micPermissionStatusLabel = getPermissionStatusLabel(
    micPermission,
    micPermissionError,
    isFetchingMicPermission,
  );
  const screenPermissionStatusLabel = getPermissionStatusLabel(
    screenPermission,
    screenPermissionError,
    isFetchingScreenPermission,
  );
  const accessibilityPermissionStatusLabel = "任意";
  const grantedPermissionCount =
    (micPermission === "granted" && !micPermissionError ? 1 : 0) +
    (screenPermission === "granted" && !screenPermissionError ? 1 : 0);
  const shouldShowFirstLaunch =
    !hasSkippedFirstLaunch &&
    (micPermission !== "granted" ||
      screenPermission !== "granted" ||
      Boolean(micPermissionError) ||
      Boolean(screenPermissionError));
  const permissionSetupLabel = isCheckingPermissions
    ? "権限状態を確認中"
    : `はじめての方へ ・ ${grantedPermissionCount} / 3 許可済み`;
  const firstLaunchSummaryLabel = [
    permissionSetupLabel,
    `${SELF_TRACK_DEVICE_LABEL}: ${micPermissionStatusLabel}`,
    `${OTHER_TRACK_DEVICE_LABEL}: ${screenPermissionStatusLabel}`,
    `ブラウザ監視: ${accessibilityPermissionStatusLabel}`,
    permissionSettingsOpenError,
  ]
    .filter(Boolean)
    .join("、");
  const sortedRecentSessions = [...(recentSessions ?? [])]
    .sort((a, b) => b.startedAtSecs - a.startedAtSecs)
    .slice(0, 2);
  const recentRecordingsLabel = recentSessionsError
    ? "直近の録音を取得できません"
    : isLoadingRecentSessions
      ? "直近の録音を確認中"
      : sortedRecentSessions.length > 0
        ? "直近の録音"
        : "直近の録音はまだありません";
  const handleShowLiveCaptionWindow = useCallback(() => {
    if (!canShowLiveCaptionWindow) {
      return;
    }
    void invoke("set_live_caption_window_visible", { visible: true }).catch((e) => {
      const msg = toErrorMessage(e);
      console.error("ライブ文字起こしウィンドウを表示できませんでした:", msg);
      setMeetingError(`ライブ文字起こしウィンドウを表示できませんでした: ${msg}`);
    });
  }, [canShowLiveCaptionWindow]);
  const handleOpenFirstLaunchPermissions = useCallback(() => {
    setPermissionSettingsOpenError(null);
    const targetUrl =
      micPermission !== "granted"
        ? MACOS_MICROPHONE_PRIVACY_URL
        : screenPermission !== "granted"
          ? MACOS_SCREEN_RECORDING_PRIVACY_URL
          : MACOS_ACCESSIBILITY_PRIVACY_URL;
    void openUrl(targetUrl)
      .then(() => {
        refetchPermissions();
      })
      .catch((e) => {
        const msg = toErrorMessage(e);
        console.error("macOS 権限設定を開けませんでした:", msg);
        setPermissionSettingsOpenError(msg);
      });
  }, [micPermission, refetchPermissions, screenPermission]);

  const handleOpenAccessibilityPermission = useCallback(() => {
    setPermissionSettingsOpenError(null);
    void openUrl(MACOS_ACCESSIBILITY_PRIVACY_URL).catch((e) => {
      const msg = toErrorMessage(e);
      console.error("アクセシビリティ権限設定を開けませんでした:", msg);
      setPermissionSettingsOpenError(msg);
    });
  }, []);

  useEffect(() => {
    if (!hasPendingMeetingStartRequest) {
      return;
    }
    if (isMeetingActive) {
      clearPendingMeetingStartRequest();
      setHasPendingMeetingStartRequest(false);
      return;
    }
    if (
      isAudioSourceOperationPending ||
      audioOperationPendingRef.current ||
      (settings === undefined && !settingsError) ||
      meetingStartBlockedReason?.includes(STATUS_CHECKING_LABEL)
    ) {
      return;
    }
    clearPendingMeetingStartRequest();
    setHasPendingMeetingStartRequest(false);
    if (!canStartMeeting) {
      setMeetingError(
        meetingStartBlockedReason
          ? `録音開始前に確認してください: ${meetingStartBlockedReason}`
          : "録音と文字起こしを開始できません。設定と権限状態を確認してください。",
      );
      return;
    }
    void handleToggleMeeting();
  }, [
    canStartMeeting,
    handleToggleMeeting,
    hasPendingMeetingStartRequest,
    isAudioSourceOperationPending,
    isMeetingActive,
    meetingStartBlockedReason,
    settings,
    settingsError,
  ]);

  return (
    <div
      className="transcript-view"
      aria-busy={isAudioSourceOperationPending}
      aria-label={transcriptViewLabel}
      title={transcriptViewLabel}
    >
      <div className="meeting-control meeting-popover-control">
        {shouldShowFirstLaunch ? (
          <div
            className="meeting-popover-main menu-first-launch"
            role="group"
            aria-busy={isCheckingPermissions}
            aria-label={firstLaunchSummaryLabel}
            title={firstLaunchSummaryLabel}
          >
            <div className="meeting-popover-header">
              <div className="meeting-popover-logo" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="meeting-popover-heading">
                <h2>Meet Jerky</h2>
                <p>自動会議録音アプリ</p>
              </div>
              <span className="menu-welcome-pill">ようこそ</span>
            </div>

            <section className="meeting-popover-detected menu-setup-hero">
              <span>{permissionSetupLabel}</span>
              <strong>セットアップを完了しましょう</strong>
              <p>
                3つの権限を許可すると、Google Meet を開いたときに自動で録音が始まります。
              </p>
            </section>

            <div className="menu-permission-list" aria-label="必要な権限">
              <div
                className={getPermissionRowClassName(
                  micPermission,
                  micPermissionError,
                )}
              >
                <span className="menu-permission-icon menu-permission-icon-hot">
                  <Mic size={16} aria-hidden="true" />
                </span>
                <span className="menu-permission-copy">
                  <strong>マイク</strong>
                  <span>あなたの音声を録音</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPermissionSettingsOpenError(null);
                    void openUrl(MACOS_MICROPHONE_PRIVACY_URL).catch((e) => {
                      const msg = toErrorMessage(e);
                      console.error("マイク権限設定を開けませんでした:", msg);
                      setPermissionSettingsOpenError(msg);
                    });
                  }}
                  aria-label={OPEN_MICROPHONE_PRIVACY_LABEL}
                  title={OPEN_MICROPHONE_PRIVACY_LABEL}
                >
                  {micPermissionStatusLabel === "許可済み" ? "済み" : "許可"}
                </button>
              </div>
              <div
                className={getPermissionRowClassName(
                  screenPermission,
                  screenPermissionError,
                )}
              >
                <span className="menu-permission-icon menu-permission-icon-cool">
                  <Volume2 size={16} aria-hidden="true" />
                </span>
                <span className="menu-permission-copy">
                  <strong>システム音声</strong>
                  <span>通話相手の声を録音</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPermissionSettingsOpenError(null);
                    void openUrl(MACOS_SCREEN_RECORDING_PRIVACY_URL).catch(
                      (e) => {
                        const msg = toErrorMessage(e);
                        console.error("画面収録設定を開けませんでした:", msg);
                        setPermissionSettingsOpenError(msg);
                      },
                    );
                  }}
                  aria-label={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
                  title={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
                >
                  {screenPermissionStatusLabel === "許可済み" ? "済み" : "許可"}
                </button>
              </div>
              <div className="menu-permission-row">
                <span className="menu-permission-icon menu-permission-icon-soft">
                  <Globe size={16} aria-hidden="true" />
                </span>
                <span className="menu-permission-copy">
                  <strong>ブラウザ監視（任意）</strong>
                  <span>Chrome の URL から Meet を自動検知</span>
                </span>
                <button
                  type="button"
                  onClick={handleOpenAccessibilityPermission}
                  aria-label={OPEN_ACCESSIBILITY_PRIVACY_LABEL}
                  title={OPEN_ACCESSIBILITY_PRIVACY_LABEL}
                >
                  許可
                </button>
              </div>
            </div>

            <div className="meeting-popover-actions">
              <button
                type="button"
                className="meeting-btn meeting-popover-primary-action"
                onClick={handleOpenFirstLaunchPermissions}
                disabled={isCheckingPermissions}
              >
                <Check size={14} aria-hidden="true" />
                すべて許可する
              </button>
              <button
                type="button"
                className="meeting-popover-secondary-action menu-secondary-link"
                onClick={() => setHasSkippedFirstLaunch(true)}
              >
                後で
              </button>
            </div>

            <div className="meeting-popover-footer">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>録音はこのMacにのみ保存されます</span>
              <button type="button" onClick={refetchPermissions}>
                再確認
              </button>
            </div>
            {permissionSettingsOpenError && (
              <p className="meeting-error meeting-alert" role="alert">
                macOS 設定を開けませんでした: {permissionSettingsOpenError}
              </p>
            )}
          </div>
        ) : (
          <div
            className={`meeting-popover-main ${
              isMeetingActive ? "menu-recording" : "menu-idle"
            }`}
          >
            <div className="meeting-popover-header">
              <div
                className={`meeting-popover-logo ${
                  isMeetingActive ? "menu-recording-logo" : "menu-idle-logo"
                }`}
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </div>
              <div className="meeting-popover-heading">
                <h2>Meet Jerky</h2>
                <p>{isMeetingActive ? meetingPopoverSubtitle : "会議の自動録音をスタンバイ"}</p>
              </div>
              <span
                className={`meeting-popover-rec-pill ${meetingRecordingStatusClass}`}
                role="status"
                aria-label={`記録の録音: ${meetingPopoverRecordingLabel}`}
                title={`記録の録音: ${meetingPopoverRecordingLabel}`}
              >
                <span aria-hidden="true" />
                {isMeetingActive ? meetingPopoverTitle : "監視中"}
              </span>
            </div>

            <section
              className="meeting-popover-detected menu-empty-card"
              aria-label="自動検知された会議"
            >
              <span className="menu-empty-icon" aria-hidden="true">
                <Target size={20} />
              </span>
              <strong>
                {isMeetingActive
                  ? meetingDetectionCardTitle
                  : "現在検知中のミーティングはありません"}
              </strong>
              <p>
                {isMeetingActive
                  ? meetingDetectionCardDetail
                  : "Google Meet を開くと自動で録音が始まります"}
              </p>
            </section>

            <section className="menu-history-section" aria-label={recentRecordingsLabel}>
              <span>{recentRecordingsLabel}</span>
              <div className="menu-history-list">
                {sortedRecentSessions.map((session) => (
                  <Link
                    key={session.path}
                    to="/sessions"
                    className="menu-history-row"
                    title={getFileName(session.path)}
                  >
                    <span aria-hidden="true" />
                    <strong>{getCompactSessionTitle(session.title)}</strong>
                    <small>{getRecentSessionMeta(session.startedAtSecs)}</small>
                  </Link>
                ))}
                {sortedRecentSessions.length === 0 && (
                  <div className="menu-history-row menu-history-row-empty">
                    <span aria-hidden="true" />
                    <strong>録音履歴はまだありません</strong>
                    <small>最初の会議を録音するとここに表示されます</small>
                  </div>
                )}
              </div>
            </section>

            <button
              type="button"
              className={`meeting-btn meeting-popover-primary-action menu-record-action ${
                isMeetingActive ? "meeting-btn-active" : ""
              }`}
              onClick={handleToggleMeeting}
              disabled={
                isMeetingOperationPending || (!canStartMeeting && !isMeetingActive)
              }
              aria-label={meetingButtonLabel}
              title={meetingButtonLabel}
              aria-describedby={
                meetingStartBlockedReason
                  ? MEETING_START_BLOCKED_REASON_ID
                  : undefined
              }
            >
              <CircleDot size={15} aria-hidden="true" />
              {isMeetingOperationPending
                ? isMeetingActive
                  ? "終了中..."
                  : "開始中..."
                : isMeetingActive
                  ? "録音を終了"
                  : "手動で録音を開始"}
            </button>

            <div className="menu-secondary-links">
              <Link to="/sessions">
                <History size={14} aria-hidden="true" />
                履歴を開く
              </Link>
              <Link to="/settings">
                <SlidersHorizontal size={14} aria-hidden="true" />
                環境設定
              </Link>
            </div>

            <div
              className="menu-live-tracks"
              hidden={!isRecordingOrTranscriptionVisible}
            >
              <div
                className="meeting-popover-track-row"
                aria-label={getMicTrackStatusAriaLabel(micTrackStatusLabel)}
                title={getMicTrackStatusAriaLabel(micTrackStatusLabel)}
              >
                <span className="meeting-popover-track-icon">MIC</span>
                <span className="meeting-popover-track-copy">
                  <strong>マイク入力</strong>
                  <span>{micPopoverSubtitle}</span>
                </span>
                <span className="meeting-popover-level" aria-hidden="true">
                  {micPopoverBars.map((bar, index) => (
                    <span
                      key={`mic-${index}`}
                      style={{ transform: `scaleY(${bar})` }}
                    />
                  ))}
                </span>
              </div>
              <div
                className="meeting-popover-track-row"
                aria-label={getSystemAudioTrackStatusAriaLabel(
                  systemAudioTrackStatusLabel,
                )}
                title={getSystemAudioTrackStatusAriaLabel(
                  systemAudioTrackStatusLabel,
                )}
              >
                <span className="meeting-popover-track-icon">SYS</span>
                <span className="meeting-popover-track-copy">
                  <strong>システム音声</strong>
                  <span>{systemAudioPopoverSubtitle}</span>
                </span>
                <span className="meeting-popover-level" aria-hidden="true">
                  {systemAudioPopoverBars.map((bar, index) => (
                    <span
                      key={`system-${index}`}
                      style={{ transform: `scaleY(${bar})` }}
                    />
                  ))}
                </span>
              </div>
              <button
                type="button"
                className="control-btn control-btn-clear meeting-popover-secondary-action"
                aria-label={showLiveCaptionWindowLabel}
                title={showLiveCaptionWindowLabel}
                onClick={handleShowLiveCaptionWindow}
                disabled={!canShowLiveCaptionWindow}
              >
                字幕ウィンドウ
              </button>
            </div>

            <div className="meeting-popover-footer">
              <SettingsIcon size={14} aria-hidden="true" />
              <span>自動検知が有効</span>
              <button
                type="button"
                onClick={handleToggleMeeting}
                disabled={!isMeetingActive || isMeetingOperationPending}
                aria-label={meetingFooterEndLabel}
                title={meetingFooterEndLabel}
              >
                終了
              </button>
            </div>
          </div>
        )}
        <div
          className="sr-only meeting-status-strip meeting-popover-status-strip"
          role="status"
          aria-busy={isMeetingStatusBusy}
          aria-live="polite"
          aria-atomic="true"
          aria-label={meetingStatusAriaLabel}
          title={meetingStatusAriaLabel}
        >
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
            {engineStatusDisplayLabel}
          </span>
          <span
            className={`meeting-status-pill ${getAiTransmissionStatusPillClass(aiTransmissionStatusLabel)}`}
            aria-label={getAiTransmissionStatusAriaLabel(
              aiTransmissionStatusLabel,
            )}
            title={getAiTransmissionStatusAriaLabel(aiTransmissionStatusLabel)}
          >
            外部送信 {aiTransmissionStatusLabel}
          </span>
          {shouldShowExternalApiKeyStatus &&
            externalApiKeyStatusLabel &&
            externalApiKeyStatusDisplayLabel && (
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
        {externalRealtimeRiskNotice && (
          <p
            className="meeting-source-notice"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`外部 Realtime 注意: ${externalRealtimeRiskNotice}`}
            title={`外部 Realtime 注意: ${externalRealtimeRiskNotice}`}
          >
            {externalRealtimeRiskNotice}
          </p>
        )}
        {shouldShowPendingMeetingStartNotice && (
          <p
            className="meeting-source-notice"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label="録音開始要求を受信済みです。設定と権限状態を確認中です。"
            title="録音開始要求を受信済みです。設定と権限状態を確認中です。"
          >
            録音開始要求を受信済みです。設定と権限状態を確認中です。
          </p>
        )}
        {meetingError && (
          <div
            className="meeting-error meeting-alert meeting-error-dismissible"
            role="alert"
            aria-label={`記録操作エラー: ${meetingError}`}
            title={`記録操作エラー: ${meetingError}`}
          >
            <span>{meetingError}</span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => setMeetingError(null)}
              aria-label="記録操作エラーを閉じる"
              title="記録操作エラーを閉じる"
            >
              閉じる
            </button>
          </div>
        )}
        {modelDownloadedErrorForUi && (
          <p
            className="meeting-error meeting-alert"
            role="alert"
            aria-label={`Whisper モデルの状態確認エラー: ${modelDownloadedErrorMessage}`}
            title={`Whisper モデルの状態確認エラー: ${modelDownloadedErrorMessage}`}
          >
            Whisper モデルの状態確認に失敗しました: {modelDownloadedErrorMessage}
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
            aria-label={`${externalApiProvider} API キーの状態確認エラー: ${externalApiKeyErrorMessage}`}
            title={`${externalApiProvider} API キーの状態確認エラー: ${externalApiKeyErrorMessage}`}
          >
            {externalApiProvider} API キーの状態確認に失敗しました:{" "}
            {externalApiKeyErrorMessage}
          </p>
        )}
        {meetingStartBlockedReason && (
          <p
            id={MEETING_START_BLOCKED_REASON_ID}
            className="meeting-start-blocked-reason"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`記録開始不可理由: ${meetingStartBlockedReason}`}
            title={`記録開始不可理由: ${meetingStartBlockedReason}`}
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
        {audioDropCountListenerError && (
          <p
            className="meeting-error meeting-alert"
            role="alert"
            aria-label={`音声 drop 監視エラー: ${audioDropCountListenerError}`}
            title={`音声 drop 監視エラー: ${audioDropCountListenerError}`}
          >
            {audioDropCountListenerError}
          </p>
        )}
        {lastSavedPath && lastSavedFileName && (
          <div
            className="meeting-saved-path"
            role="group"
            aria-label={lastSavedActionsLabel}
            title={lastSavedActionsLabel}
          >
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={`文字起こし履歴ファイルを保存しました: ${lastSavedFileName}`}
              title={`文字起こし履歴ファイルを保存しました: ${lastSavedFileName}`}
            >
              履歴ファイルを保存しました: {lastSavedFileName}
            </span>
            <span className="meeting-saved-path-actions">
              <button
                type="button"
                className="control-btn control-btn-clear"
                onClick={() => {
                  void handleOpenLastSavedFile();
                }}
                disabled={savedFileActionPending !== null}
                aria-label={lastSavedOpenLabel}
                title={lastSavedOpenLabel}
              >
                {savedFileActionPending === "open" ? "開いています..." : "履歴で開く"}
              </button>
              <button
                type="button"
                className="control-btn control-btn-clear"
                onClick={() => {
                  void handleRevealLastSavedFile();
                }}
                disabled={savedFileActionPending !== null}
                aria-label={lastSavedRevealLabel}
                title={lastSavedRevealLabel}
              >
                {savedFileActionPending === "reveal"
                  ? "表示中..."
                  : "Finder で表示"}
              </button>
            </span>
          </div>
        )}
        {savedFileActionError && (
          <div
            className="meeting-error meeting-alert meeting-error-dismissible"
            role="alert"
            aria-label={`保存済み履歴ファイル操作エラー: ${savedFileActionError}`}
            title={`保存済み履歴ファイル操作エラー: ${savedFileActionError}`}
          >
            <span>{savedFileActionError}</span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => setSavedFileActionError(null)}
              aria-label="保存済み履歴ファイル操作エラーを閉じる"
              title="保存済み履歴ファイル操作エラーを閉じる"
            >
              閉じる
            </button>
          </div>
        )}
      </div>

      <div
        className="menu-advanced-controls"
        hidden={!isRecordingOrTranscriptionVisible}
      >
        <div className="section-divider" />

        <MicrophoneSection
          isMicRecording={isMicRecording}
          micLevel={micLevel}
          micDropCountTotal={microphoneDropCountTotal}
          selectedDeviceId={selectedDeviceId}
          audioDevices={devices}
          audioDevicesError={devicesError}
          isReloadingAudioDevices={isFetchingDevices}
          isOperationPending={isMicSourceOperationPending}
          isControlDisabled={isAudioSourceOperationPending}
          isCompact={isRecordingOrTranscriptionVisible}
          onDeviceChange={setSelectedDeviceId}
          onRetryDevices={() => refetchDevices()}
          onToggleRecording={handleToggleMicRecording}
        />

        <SystemAudioSection
          isSystemAudioRecording={isSystemAudioRecording}
          systemAudioLevel={systemAudioLevel}
          systemAudioDropCountTotal={systemAudioDropCountTotal}
          isOperationPending={isSystemAudioSourceOperationPending}
          isControlDisabled={isAudioSourceOperationPending}
          isCompact={isRecordingOrTranscriptionVisible}
          onToggleSystemAudio={handleToggleSystemAudio}
        />

        <div className="section-divider" />

        <TranscriptionControls
          isTranscribing={isTranscribing}
          hasTranscriptionErrorStopped={hasTranscriptionErrorStopped}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          showModelSelector={requiresLocalModel}
          onToggleTranscription={handleToggleTranscription}
          canStartTranscription={canStartTranscription}
          isTranscriptionOperationPending={isTranscriptionOperationPending}
          startBlockedReason={transcriptionStartBlockedReason}
          sourceStatusText={transcriptionSourceStatus}
          sourceStatusAriaText={transcriptionSourceStatusAriaText}
          sourceStatusIsWarning={transcriptionSourceStatusIsWarning}
          segmentsCount={segments.length}
          onClearTranscript={handleClearTranscript}
        />

        <TranscriptDisplay
          segments={segments}
          onNewSegment={handleNewSegment}
        />
      </div>
    </div>
  );
}
