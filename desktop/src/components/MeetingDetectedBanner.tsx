import { useEffect, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Captions } from "lucide-react";
import type { MeetingAppDetectedPayload } from "../types";
import {
  clearPendingMeetingStartRequest,
  markMeetingDetectionStartRequest,
  MEETING_START_REQUEST_EVENT,
} from "../utils/meetingStartRequest";
import { getMeetingDetectedDisplayName } from "../utils/meetingDetectedBannerHelpers";
import {
  getMeetingAppDetectedPayloadIssue,
  isMeetingAppDetectedPayload,
  MEETING_APP_DETECTED_EVENT,
} from "../utils/meetingDetection";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getLiveCaptionStatusPayloadIssue,
  getTransmissionStatusAriaLabel,
  getVisibleTransmissionLabel,
  isLiveCaptionStatusPayload,
  LOCAL_AUDIO_TRANSMISSION_LABEL,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import { getVisibleTrackSummary } from "../utils/liveCaptionTrackHelpers";
import { isTauriRuntime } from "../utils/browserRuntime";

const PROMPT_AUTO_HIDE_MS = 15000;
const PROMPT_EMPTY_BOOT_HIDE_MS = 2000;
const INVALID_MEETING_DETECTION_PAYLOAD_ERROR =
  "会議検知を確認できませんでした。";
const INVALID_STATUS_PAYLOAD_ERROR = "録音状態を確認できませんでした。";
type PendingPromptAction = "start" | null;

const PREVIEW_MEETING_DETECTED_PAYLOAD: MeetingAppDetectedPayload = {
  bundleId: "com.google.Chrome",
  appName: "Google Chrome",
  source: "browser",
  service: "Google Meet",
  urlHost: "meet.google.com",
  browserName: "Chrome",
};

const PREVIEW_MEETING_STATUS: LiveCaptionStatusPayload = {
  engineLabel: "Whisper",
  aiTransmissionLabel: LOCAL_AUDIO_TRANSMISSION_LABEL,
  isExternalTransmission: false,
  transcriptionStatusLabel: "停止中",
  microphoneTrackLabel: "録音待機",
  systemAudioTrackLabel: "取得待機",
};

interface PromptState {
  detected: MeetingAppDetectedPayload | null;
  statusPayload: LiveCaptionStatusPayload;
  listenerError: string | null;
  pendingAction: PendingPromptAction;
  showsRecordingPill: boolean;
}

type PromptAction =
  | {
      type: "meeting-detected";
      payload: MeetingAppDetectedPayload;
      statusPayload: LiveCaptionStatusPayload;
    }
  | { type: "invalid-detection"; error: string }
  | { type: "set-status"; statusPayload: LiveCaptionStatusPayload }
  | { type: "clear-error-prefix"; prefix: string }
  | { type: "set-error"; error: string }
  | { type: "set-pending-action"; pendingAction: PendingPromptAction }
  | { type: "show-recording-pill" }
  | { type: "hide-recording-pill" }
  | { type: "clear-all" };

function createInitialPromptState(): PromptState {
  if (!isTauriRuntime()) {
    return {
      detected: PREVIEW_MEETING_DETECTED_PAYLOAD,
      statusPayload: PREVIEW_MEETING_STATUS,
      listenerError: null,
      pendingAction: null,
      showsRecordingPill: false,
    };
  }
  return {
    detected: null,
    statusPayload: readPromptLiveCaptionStatus(),
    listenerError: null,
    pendingAction: null,
    showsRecordingPill: false,
  };
}

function promptReducer(state: PromptState, action: PromptAction): PromptState {
  switch (action.type) {
    case "meeting-detected":
      return {
        detected: action.payload,
        statusPayload: action.statusPayload,
        listenerError: null,
        pendingAction: null,
        showsRecordingPill: false,
      };
    case "invalid-detection":
      return {
        ...state,
        detected: null,
        listenerError: action.error,
        pendingAction: null,
        showsRecordingPill: false,
      };
    case "set-status":
      return {
        ...state,
        statusPayload: action.statusPayload,
      };
    case "clear-error-prefix":
      return {
        ...state,
        listenerError: state.listenerError?.startsWith(action.prefix)
          ? null
          : state.listenerError,
      };
    case "set-error":
      return {
        ...state,
        listenerError: action.error,
        pendingAction: null,
      };
    case "set-pending-action":
      return {
        ...state,
        pendingAction: action.pendingAction,
      };
    case "show-recording-pill":
      return {
        ...state,
        detected: null,
        listenerError: null,
        pendingAction: null,
        showsRecordingPill: true,
      };
    case "hide-recording-pill":
      return {
        ...state,
        showsRecordingPill: false,
      };
    case "clear-all":
      return {
        ...state,
        detected: null,
        listenerError: null,
        pendingAction: null,
        showsRecordingPill: false,
      };
  }
}

function isRecordingStatusVisible(status: LiveCaptionStatusPayload): boolean {
  return (
    status.transcriptionStatusLabel === "開始中" ||
    status.transcriptionStatusLabel === "文字起こし中" ||
    status.microphoneTrackLabel.includes("録音中") ||
    status.microphoneTrackLabel === "切替中" ||
    status.systemAudioTrackLabel.includes("取得中") ||
    status.systemAudioTrackLabel === "切替中"
  );
}

function getInvalidMeetingDetectionPayloadError(payload: unknown): string {
  const issue = getMeetingAppDetectedPayloadIssue(payload);
  console.error("会議検知通知の形式が不正です:", issue);
  return INVALID_MEETING_DETECTION_PAYLOAD_ERROR;
}

async function hideMeetingPromptWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("set_meeting_prompt_window_visible", { visible: false });
}

async function showMeetingPromptWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("set_meeting_prompt_window_visible", { visible: true });
}

async function showMainWindowForMeetingStartRequest(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("show_main_window");
}

async function showLiveCaptionWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("set_live_caption_window_visible", { visible: true });
}

function readPromptLiveCaptionStatus(): LiveCaptionStatusPayload {
  return readStoredLiveCaptionStatus((e) => {
    console.error(
      "会議検知プロンプトの文字起こしステータス読み取りに失敗しました:",
      toErrorMessage(e),
    );
  });
}

/// 会議アプリまたはブラウザ会議 URL を検知したら、画面上部にバナーを出して
/// ユーザーに録音と文字起こしの状態確認を促すグローバルコンポーネント。
///
/// 設計メモ:
/// - 自動で記録開始まで踏み込むと、TranscriptView のローカル状態 (mic / system
///   audio / engine) を外部から操作する必要があり、副作用の追跡が難しくなる。
/// - 本コンポーネントはあくまで導線の提示にとどめ、ユーザー操作で記録ボタンを
///   押してもらう。TranscriptView 側で「auto-start ready」状態を持たせる場合も
///   発展させやすいよう、検知元の最小情報をペイロードとして保持する。
export function MeetingDetectedBanner() {
  const isBrowserPreview = !isTauriRuntime();
  const [state, dispatch] = useReducer(
    promptReducer,
    undefined,
    createInitialPromptState,
  );
  const {
    detected,
    statusPayload,
    listenerError,
    pendingAction,
    showsRecordingPill,
  } = state;
  const hasReceivedPromptContentRef = useRef(false);
  const hasSeenRecordingStatusRef = useRef(false);

  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    let disposed = false;
    const applyMeetingDetectionPayload = (
      payload: MeetingAppDetectedPayload,
    ) => {
      hasReceivedPromptContentRef.current = true;
      hasSeenRecordingStatusRef.current = false;
      dispatch({
        type: "meeting-detected",
        payload,
        statusPayload: readPromptLiveCaptionStatus(),
      });
    };
    const recoverLatestMeetingDetection = async () => {
      const payload = await invoke<unknown>("take_latest_meeting_detection");
      if (disposed || payload == null) {
        return;
      }
      if (!isMeetingAppDetectedPayload(payload)) {
        hasReceivedPromptContentRef.current = true;
        hasSeenRecordingStatusRef.current = false;
        dispatch({
          type: "invalid-detection",
          error: getInvalidMeetingDetectionPayloadError(payload),
        });
        return;
      }
      applyMeetingDetectionPayload(payload);
    };
    const isSameMeetingDetectionPayload = (
      a: MeetingAppDetectedPayload,
      b: MeetingAppDetectedPayload,
    ) =>
      a.source === b.source &&
      a.bundleId === b.bundleId &&
      a.appName === b.appName &&
      a.service === b.service &&
      a.urlHost === b.urlHost &&
      a.browserName === b.browserName;
    const consumeLatestMeetingDetection = async (
      deliveredPayload: MeetingAppDetectedPayload,
    ) => {
      const payload = await invoke<unknown>("take_latest_meeting_detection");
      if (disposed || payload == null) {
        return;
      }
      if (!isMeetingAppDetectedPayload(payload)) {
        dispatch({
          type: "invalid-detection",
          error: getInvalidMeetingDetectionPayloadError(payload),
        });
        return;
      }
      if (isSameMeetingDetectionPayload(payload, deliveredPayload)) {
        return;
      }
      applyMeetingDetectionPayload(payload);
    };
    const detectedUnlistenPromise = listen<unknown>(
      MEETING_APP_DETECTED_EVENT,
      (e) => {
        if (disposed) {
          return;
        }
        if (!isMeetingAppDetectedPayload(e.payload)) {
          hasReceivedPromptContentRef.current = true;
          hasSeenRecordingStatusRef.current = false;
          dispatch({
            type: "invalid-detection",
            error: getInvalidMeetingDetectionPayloadError(e.payload),
          });
          return;
        }
        applyMeetingDetectionPayload(e.payload);
        void consumeLatestMeetingDetection(e.payload).catch((e) => {
          const msg = toErrorMessage(e);
          console.error("受信済み会議検知通知の消費に失敗しました:", msg);
          if (!disposed) {
            dispatch({
              type: "set-error",
              error: "会議検知を確認できませんでした。",
            });
          }
        });
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          dispatch({
            type: "clear-error-prefix",
            prefix: INVALID_MEETING_DETECTION_PAYLOAD_ERROR,
          });
          void recoverLatestMeetingDetection().catch((e) => {
            const msg = toErrorMessage(e);
            console.error("最新の会議検知通知の回収に失敗しました:", msg);
            if (!disposed) {
              hasReceivedPromptContentRef.current = true;
              hasSeenRecordingStatusRef.current = false;
              dispatch({
                type: "invalid-detection",
                error: "会議検知を確認できませんでした。",
              });
            }
          });
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("会議検知通知の受信開始に失敗しました:", msg);
          dispatch({
            type: "set-error",
            error: "会議検知を確認できませんでした。",
          });
        }
        return null;
      });
    const statusUnlistenPromise = listen<unknown>(
      LIVE_CAPTION_STATUS_EVENT,
      (event) => {
        if (!disposed) {
          if (isLiveCaptionStatusPayload(event.payload)) {
            dispatch({
              type: "clear-error-prefix",
              prefix: INVALID_STATUS_PAYLOAD_ERROR,
            });
            dispatch({
              type: "set-status",
              statusPayload: normalizeLiveCaptionStatusPayload(event.payload),
            });
            return;
          }
          if (!hasReceivedPromptContentRef.current) {
            dispatch({
              type: "clear-error-prefix",
              prefix: INVALID_STATUS_PAYLOAD_ERROR,
            });
            void hideMeetingPromptWindow().catch((e) => {
              console.error(
                "会議検知前の不正な文字起こしステータス通知によるプロンプト非表示に失敗しました:",
                toErrorMessage(e),
              );
            });
            return;
          }
          const issue = getLiveCaptionStatusPayloadIssue(event.payload);
          console.error("会議検知プロンプトの状態通知の形式が不正です:", issue);
          dispatch({
            type: "set-error",
            error: INVALID_STATUS_PAYLOAD_ERROR,
          });
        }
      },
    ).catch((e) => {
      if (!disposed) {
        const msg = toErrorMessage(e);
        console.error(
          "会議検知プロンプトの文字起こしステータス受信開始に失敗しました:",
          msg,
        );
        dispatch({
          type: "set-error",
          error: "録音状態を確認できませんでした。",
        });
      }
      return null;
    });

    return () => {
      disposed = true;
      detectedUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "会議検知通知の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
      statusUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "会議検知プロンプトの文字起こしステータス受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, [isBrowserPreview]);

  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      if (hasReceivedPromptContentRef.current) {
        return;
      }
      void hideMeetingPromptWindow().catch((e) => {
        console.error(
          "空の会議検知プロンプトの非表示に失敗しました:",
          toErrorMessage(e),
        );
      });
    }, PROMPT_EMPTY_BOOT_HIDE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isBrowserPreview]);

  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    if (
      !detected &&
      !showsRecordingPill &&
      !(listenerError && hasReceivedPromptContentRef.current)
    ) {
      return;
    }
    void showMeetingPromptWindow().catch((e) => {
      console.error(
        "会議検知プロンプトの表示に失敗しました:",
        toErrorMessage(e),
      );
    });
  }, [detected, isBrowserPreview, listenerError, showsRecordingPill]);

  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    if (!showsRecordingPill) {
      hasSeenRecordingStatusRef.current = false;
      return;
    }
    if (isRecordingStatusVisible(statusPayload)) {
      hasSeenRecordingStatusRef.current = true;
      return;
    }
    if (!hasSeenRecordingStatusRef.current) {
      return;
    }
    void hideMeetingPromptWindow()
      .then(() => {
        clearPendingMeetingStartRequest();
        dispatch({ type: "hide-recording-pill" });
      })
      .catch((e) => {
        const msg = toErrorMessage(e);
        console.error("記録状態pillの自動非表示に失敗しました:", msg);
        dispatch({
          type: "set-error",
          error: "録音状態を確認できませんでした。",
        });
      });
  }, [isBrowserPreview, showsRecordingPill, statusPayload]);

  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    if (!detected || listenerError || pendingAction) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void hideMeetingPromptWindow()
        .then(() => {
          clearPendingMeetingStartRequest();
          hasSeenRecordingStatusRef.current = false;
          dispatch({ type: "clear-all" });
        })
        .catch((e) => {
          const msg = toErrorMessage(e);
          console.error("会議検知バナーの自動非表示に失敗しました:", msg);
          dispatch({
            type: "set-error",
            error: "会議検知を確認できませんでした。",
          });
        });
    }, PROMPT_AUTO_HIDE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [detected, isBrowserPreview, listenerError, pendingAction]);

  const displayName = detected ? getMeetingDetectedDisplayName(detected) : null;
  const bannerTitle = listenerError
    ? listenerError
    : displayName
      ? `${displayName} を検知`
      : "会議を検知";
  const bannerAriaLabel = listenerError
    ? listenerError
    : displayName
      ? `${displayName} を検知。録音前確認。自分 + 相手側を別トラックでこのMacに保存し、REC表示、ライブ文字起こし、AIノートのオン/オフ確認へ進みます。`
      : "会議を検知。録音前確認。自分 + 相手側を別トラックでこのMacに保存し、REC表示、ライブ文字起こし、AIノートのオン/オフ確認へ進みます。";
  const startRecordingLabel = detected
    ? pendingAction === "start"
      ? "録音開始を要求中。REC表示、ライブ文字起こし、AIノートのオン/オフ確認を準備します。"
      : `${displayName} の録音を開始し、自分 + 相手側を別トラックでこのMacに保存してREC表示、ライブ文字起こし、AIノートのオン/オフ確認を開きます。`
    : "録音を開始し、自分 + 相手側を別トラックでこのMacに保存してREC表示、ライブ文字起こし、AIノートのオン/オフ確認を開きます。";
  const dismissBannerLabel = pendingAction ? "録音操作中" : "録音せず閉じる";
  const errorRecoveryLabel =
    "録音開始前に、macOS権限、会議検出設定、メニューバー録音を確認してください。";
  const bannerRole = listenerError ? "alert" : "status";
  const bannerClassName = listenerError
    ? "meeting-detected-banner meeting-detected-banner-error"
    : "meeting-detected-banner";
  const recordingPillAriaLabel = `録音中。自分 ${statusPayload.microphoneTrackLabel}。相手側 ${statusPayload.systemAudioTrackLabel}。`;
  const recordingPillTitle =
    statusPayload.transcriptionStatusLabel === "文字起こし中"
      ? "録音中"
      : "録音状態を表示中";
  const recordingPillTrackSummary = getVisibleTrackSummary(statusPayload);
  const recordingPillTrackLabel =
    recordingPillTrackSummary === "自分 + 相手側"
      ? recordingPillTrackSummary
      : `自分 ${statusPayload.microphoneTrackLabel} / 相手側 ${statusPayload.systemAudioTrackLabel}`;
  const recordingPillTransmissionLabel =
    getVisibleTransmissionLabel(statusPayload);
  const recordingPillTransmissionAriaLabel =
    getTransmissionStatusAriaLabel(statusPayload);
  const openLiveCaptionLabel = `ライブ文字起こしを開く。REC表示中、${recordingPillTrackLabel}、${recordingPillTransmissionAriaLabel}。`;
  const recordingPillAiClassName = !statusPayload.isExternalTransmission
    ? "meeting-detected-status-ai meeting-detected-status-ai-safe"
    : "meeting-detected-status-ai meeting-detected-status-ai-warning";
  const promptAudioTransmissionLabel =
    statusPayload.aiTransmissionLabel === "なし" ||
    statusPayload.aiTransmissionLabel === LOCAL_AUDIO_TRANSMISSION_LABEL
      ? "音声外部送信なし"
      : `音声外部送信 ${statusPayload.aiTransmissionLabel}`;
  const promptStartFlow = [
    {
      label: "検知",
      value: detected?.service ?? detected?.source ?? "会議",
      tone: "accent",
    },
    {
      label: "開始",
      value: pendingAction === "start" ? "準備中" : "確認録音",
      tone: pendingAction === "start" ? "warn" : "accent",
    },
    {
      label: "表示",
      value: "REC / 文字起こし",
      tone: "safe",
    },
    {
      label: "保存",
      value: promptAudioTransmissionLabel,
      tone: statusPayload.isExternalTransmission ? "warn" : "safe",
    },
  ] as const;
  const promptStartFlowLabel = [
    "会議検知から録音開始までの流れ",
    `検知 ${promptStartFlow[0].value}`,
    `開始 ${promptStartFlow[1].value}`,
    "開始後はREC表示とライブ文字起こしを開きます",
    `保存 ${promptAudioTransmissionLabel}`,
  ].join("。");
  const handleStartRecording = async () => {
    if (pendingAction) {
      return;
    }
    dispatch({ type: "set-pending-action", pendingAction: "start" });
    markMeetingDetectionStartRequest();
    try {
      if (!isBrowserPreview) {
        await emit(MEETING_START_REQUEST_EVENT);
      }
    } catch (e) {
      clearPendingMeetingStartRequest();
      const msg = toErrorMessage(e);
      console.error("録音開始要求の送信に失敗しました:", msg);
      dispatch({
        type: "set-error",
        error: "録音開始要求を送信できませんでした。",
      });
      return;
    }
    try {
      await showMainWindowForMeetingStartRequest();
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("メインウィンドウの表示に失敗しました:", msg);
      dispatch({
        type: "set-error",
        error: "録音画面を開けませんでした。",
      });
      return;
    }
    hasSeenRecordingStatusRef.current = false;
    if (isBrowserPreview) {
      dispatch({
        type: "set-status",
        statusPayload: {
          ...PREVIEW_MEETING_STATUS,
          transcriptionStatusLabel: "文字起こし中",
          microphoneTrackLabel: "録音中",
          systemAudioTrackLabel: "取得中",
        },
      });
    }
    dispatch({ type: "show-recording-pill" });
  };
  const handleDismissBanner = async () => {
    try {
      await hideMeetingPromptWindow();
      clearPendingMeetingStartRequest();
      hasSeenRecordingStatusRef.current = false;
      dispatch({ type: "clear-all" });
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("会議検知バナーを閉じられませんでした:", msg);
      dispatch({
        type: "set-error",
        error: "会議検知バナーを閉じられませんでした。",
      });
    }
  };
  const handleOpenLiveCaption = async () => {
    try {
      await showLiveCaptionWindow();
    } catch (e) {
      const msg = toErrorMessage(e);
      console.error("ライブ文字起こしウィンドウを表示できませんでした:", msg);
      dispatch({
        type: "set-error",
        error: "ライブ文字起こしを開けませんでした。",
      });
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingAction) {
        void handleDismissBanner();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pendingAction]);

  if (!detected && !listenerError && !showsRecordingPill) return null;

  if (showsRecordingPill && !detected && !listenerError) {
    return (
      <div
        className="meeting-detected-status-pill"
        data-tauri-drag-region
        role="status"
        aria-live="polite"
        aria-label={recordingPillAriaLabel}
        title={recordingPillAriaLabel}
      >
        <span className="meeting-detected-status-dot" aria-hidden="true" />
        <span className="meeting-detected-status-copy" data-tauri-drag-region>
          <strong data-tauri-drag-region>{recordingPillTitle}</strong>
          <small data-tauri-drag-region>{recordingPillTrackLabel}</small>
        </span>
        <span
          className={recordingPillAiClassName}
          data-tauri-drag-region
          aria-label={recordingPillTransmissionAriaLabel}
          title={recordingPillTransmissionAriaLabel}
        >
          {recordingPillTransmissionLabel}
        </span>
        <button
          type="button"
          className="meeting-detected-status-open"
          aria-label={openLiveCaptionLabel}
          title={openLiveCaptionLabel}
          onClick={() => {
            void handleOpenLiveCaption();
          }}
        >
          <Captions size={11} aria-hidden="true" />
          文字起こしを表示
        </button>
      </div>
    );
  }

  return (
    <div
      className={bannerClassName}
      data-tauri-drag-region
      role={bannerRole}
      aria-live={bannerRole === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={bannerAriaLabel}
      title={bannerAriaLabel}
    >
      {!listenerError && (
        <span className="meeting-detected-banner-top" data-tauri-drag-region>
          <span className="meeting-detected-banner-text" data-tauri-drag-region>
            <span
              className="meeting-detected-banner-title"
              data-tauri-drag-region
            >
              {bannerTitle}
            </span>
          </span>
        </span>
      )}
      {detected && !listenerError && (
        <span
          className="meeting-detected-start-flow"
          data-tauri-drag-region
          role="status"
          aria-label={promptStartFlowLabel}
          title={promptStartFlowLabel}
        >
          {promptStartFlow.map((item) => (
            <span
              key={`${item.label}-${item.value}`}
              className={`meeting-detected-start-flow-chip meeting-detected-start-flow-chip-${item.tone}`}
              data-tauri-drag-region
            >
              <span data-tauri-drag-region>{item.label}</span>
              <strong data-tauri-drag-region>{item.value}</strong>
            </span>
          ))}
        </span>
      )}
      {listenerError && (
        <span className="meeting-detected-banner-text" data-tauri-drag-region>
          <span
            className="meeting-detected-banner-title"
            data-tauri-drag-region
          >
            {bannerTitle}
          </span>
          <span
            className="meeting-detected-banner-recovery"
            data-tauri-drag-region
            aria-label={errorRecoveryLabel}
            title={errorRecoveryLabel}
          >
            権限・検出設定・メニューバー録音を確認
          </span>
        </span>
      )}
      {(detected || listenerError) && (
        <div className="meeting-detected-banner-actions">
          {detected && (
            <button
              type="button"
              className="control-btn control-btn-transcribe"
              disabled={Boolean(pendingAction)}
              aria-label={startRecordingLabel}
              title={startRecordingLabel}
              onClick={() => {
                void handleStartRecording();
              }}
            >
              <Captions
                className="meeting-detected-start-icon"
                aria-hidden="true"
                size={15}
                strokeWidth={2.4}
              />
              {pendingAction === "start" ? "録音開始中…" : "録音開始"}
            </button>
          )}
          <button
            type="button"
            className="control-btn control-btn-clear meeting-detected-dismiss-btn"
            disabled={Boolean(pendingAction)}
            aria-label={dismissBannerLabel}
            aria-keyshortcuts="Escape"
            title={dismissBannerLabel}
            onClick={() => {
              void handleDismissBanner();
            }}
          >
            録音せず閉じる
          </button>
        </div>
      )}
    </div>
  );
}
