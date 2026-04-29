import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MeetingAppDetectedPayload } from "../types";
import {
  clearPendingMeetingStartRequest,
  markPendingMeetingStartRequest,
} from "../utils/meetingStartRequest";
import { isMeetingAppDetectedPayload } from "../utils/meetingDetection";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getVisibleTransmissionLabel,
  isLiveCaptionStatusPayload,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";

const MEETING_START_REQUEST_EVENT = "meet-jerky-start-recording-requested";
const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";
const PROMPT_AUTO_HIDE_MS = 15000;
const PROMPT_AUTO_HIDE_SECONDS = PROMPT_AUTO_HIDE_MS / 1000;
const INVALID_STATUS_PAYLOAD_ERROR =
  "会議検知プロンプトの状態通知の形式が不正です。";
const AUDIO_TRACKS_ARIA_LABEL =
  "自分トラック マイク、相手側トラック システム音声";
type PendingPromptAction = "start" | "confirm" | null;

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
///   押してもらう。今後 TranscriptView 側に「auto-start ready」状態を持たせる
///   形で発展させやすいよう、検知元の最小情報をペイロードとして保持する。
export function MeetingDetectedBanner() {
  const [detected, setDetected] = useState<MeetingAppDetectedPayload | null>(
    null,
  );
  const [statusPayload, setStatusPayload] =
    useState<LiveCaptionStatusPayload>(readPromptLiveCaptionStatus);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] =
    useState<PendingPromptAction>(null);

  useEffect(() => {
    let disposed = false;
    const detectedUnlistenPromise = listen<unknown>(
      "meeting-app-detected",
      (e) => {
        if (disposed) {
          return;
        }
        if (!isMeetingAppDetectedPayload(e.payload)) {
          setDetected(null);
          setPendingAction(null);
          setListenerError("会議検知通知の形式が不正です。");
          return;
        }
        setListenerError(null);
        setPendingAction(null);
        setStatusPayload(readPromptLiveCaptionStatus());
        setDetected(e.payload);
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("会議検知通知の受信開始に失敗しました:", msg);
          setListenerError(`会議検知通知の受信開始に失敗しました: ${msg}`);
        }
        return null;
      });
    const statusUnlistenPromise = listen<unknown>(
      LIVE_CAPTION_STATUS_EVENT,
      (event) => {
        if (!disposed) {
          if (isLiveCaptionStatusPayload(event.payload)) {
            setListenerError((current) =>
              current === INVALID_STATUS_PAYLOAD_ERROR ? null : current,
            );
            setStatusPayload(normalizeLiveCaptionStatusPayload(event.payload));
            return;
          }
          setListenerError(INVALID_STATUS_PAYLOAD_ERROR);
        }
      },
    ).catch((e) => {
      if (!disposed) {
        console.error(
          "会議検知プロンプトの文字起こしステータス受信開始に失敗しました:",
          toErrorMessage(e),
        );
      }
      return null;
    });

    return () => {
      disposed = true;
      detectedUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error("会議検知通知の受信解除に失敗しました:", toErrorMessage(e));
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
  }, []);

  useEffect(() => {
    if (!detected || listenerError || pendingAction) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      clearPendingMeetingStartRequest();
      setPendingAction(null);
      setDetected(null);
      void getCurrentWindow().hide();
    }, PROMPT_AUTO_HIDE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [detected, listenerError, pendingAction]);

  const displayName = detected ? getMeetingDetectedDisplayName(detected) : null;
  const sourceLabel = detected ? getMeetingDetectedSourceLabel(detected) : null;
  const visibleTransmissionLabel = getVisibleTransmissionLabel(statusPayload);
  const transmissionAriaLabel = statusPayload.isExternalTransmission
    ? `外部送信: ${statusPayload.aiTransmissionLabel}`
    : "外部送信なし、端末内で処理";
  const bannerTitle = listenerError
    ? listenerError
    : "録音しますか？";
  const bannerDetail = listenerError
    ? null
    : `${displayName} を検出。録音と文字起こしの状態を確認できます。約${PROMPT_AUTO_HIDE_SECONDS}秒後に隠れます。`;
  const bannerAriaLabel = listenerError
    ? listenerError
    : `${displayName} を検出しました。${
        sourceLabel ? `検知元 ${sourceLabel}。` : ""
      }文字起こしエンジン ${statusPayload.engineLabel}。外部送信 ${statusPayload.aiTransmissionLabel}。${AUDIO_TRACKS_ARIA_LABEL} の録音と文字起こしの状態を確認してください。約${PROMPT_AUTO_HIDE_SECONDS}秒後に自動で隠れます。`;
  const confirmRecordingLabel = detected
    ? pendingAction === "confirm"
      ? `${displayName} の録音と文字起こしの状態確認画面を開いています`
      : pendingAction === "start"
        ? `${displayName} の録音開始要求を送信中のため状態確認画面を開けません`
      : `${displayName} の録音と文字起こしの状態を確認`
    : "録音と文字起こしの状態を確認";
  const startRecordingLabel = detected
    ? pendingAction === "start"
      ? `${displayName} の録音開始要求を送信中`
      : pendingAction === "confirm"
        ? `${displayName} の状態確認画面を開いているため録音開始要求を送信できません`
      : `${displayName} の録音と文字起こしを開始`
    : "録音と文字起こしを開始";
  const dismissBannerLabel = pendingAction
    ? "操作中のため会議検知バナーを閉じられません"
    : "会議検知バナーを閉じる";
  const bannerRole = listenerError ? "alert" : "status";
  const bannerClassName = listenerError
    ? "meeting-detected-banner meeting-detected-banner-error"
    : "meeting-detected-banner";
  const handleStartRecording = async () => {
    if (pendingAction) {
      return;
    }
    setPendingAction("start");
    markPendingMeetingStartRequest();
    try {
      await emit(MEETING_START_REQUEST_EVENT);
      await getCurrentWindow().hide();
      setDetected(null);
    } catch (e) {
      clearPendingMeetingStartRequest();
      setDetected(null);
      setPendingAction(null);
      setListenerError(`録音開始要求の送信に失敗しました: ${toErrorMessage(e)}`);
    }
  };
  const handleConfirmRecordingState = async () => {
    if (pendingAction) {
      return;
    }
    setPendingAction("confirm");
    clearPendingMeetingStartRequest();
    try {
      await emit(SHOW_MAIN_WINDOW_REQUEST_EVENT);
      await getCurrentWindow().hide();
      setDetected(null);
    } catch (e) {
      setDetected(null);
      setPendingAction(null);
      setListenerError(`録音状態確認画面の表示要求に失敗しました: ${toErrorMessage(e)}`);
    }
  };
  const handleDismissBanner = async () => {
    clearPendingMeetingStartRequest();
    setDetected(null);
    setListenerError(null);
    setPendingAction(null);
    try {
      await getCurrentWindow().hide();
    } catch (e) {
      console.error("会議検知バナーを隠せませんでした:", toErrorMessage(e));
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

  if (!detected && !listenerError) return null;

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
        <div
          className="meeting-detected-attention-mark"
          data-tauri-drag-region
          aria-hidden="true"
        >
          <span className="meeting-detected-attention-dot" />
        </div>
      )}
      <span className="meeting-detected-banner-text" data-tauri-drag-region>
        <span
          className="meeting-detected-banner-title"
          data-tauri-drag-region
        >
          {bannerTitle}
        </span>
        {bannerDetail && (
          <span
            className="meeting-detected-banner-detail"
            data-tauri-drag-region
          >
            {bannerDetail}
          </span>
        )}
        {!listenerError && (
          <span className="meeting-detected-meta" data-tauri-drag-region>
            {sourceLabel && (
              <span
                className="meeting-detected-source-badge"
                data-tauri-drag-region
                aria-label={`検知元: ${sourceLabel}`}
                title={`検知元: ${sourceLabel}`}
              >
                {sourceLabel}
              </span>
            )}
            <span
              className="meeting-detected-source-badge meeting-detected-engine-badge"
              data-tauri-drag-region
              aria-label={`文字起こしエンジン: ${statusPayload.engineLabel}`}
              title={`文字起こしエンジン: ${statusPayload.engineLabel}`}
            >
              {statusPayload.engineLabel}
            </span>
            <span
              className={`meeting-detected-source-badge meeting-detected-privacy-badge${
                statusPayload.isExternalTransmission
                  ? " meeting-detected-privacy-badge-warning"
                  : ""
              }`}
              data-tauri-drag-region
              aria-label={transmissionAriaLabel}
              title={transmissionAriaLabel}
            >
              {visibleTransmissionLabel}
            </span>
          </span>
        )}
      </span>
      {(detected || listenerError) && (
        <div className="meeting-detected-banner-actions">
          {detected && (
            <>
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
                {pendingAction === "start"
                  ? "開始要求中..."
                  : pendingAction === "confirm"
                    ? "表示要求中..."
                    : "記録を開始"}
              </button>
              <button
                type="button"
                className="control-btn control-btn-clear"
                disabled={Boolean(pendingAction)}
                aria-label={confirmRecordingLabel}
                title={confirmRecordingLabel}
                onClick={() => {
                  void handleConfirmRecordingState();
                }}
              >
                {pendingAction === "confirm"
                  ? "表示要求中..."
                  : pendingAction === "start"
                    ? "開始要求中..."
                    : "状態を確認"}
              </button>
            </>
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
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export function getMeetingDetectedDisplayName(
  payload: MeetingAppDetectedPayload,
): string {
  if (payload.service && payload.urlHost) {
    return `${payload.service} (${payload.urlHost})`;
  }
  return payload.service || payload.urlHost || payload.appName;
}

export function getMeetingDetectedSourceLabel(
  payload: MeetingAppDetectedPayload,
): string {
  if (payload.browserName && payload.urlHost) {
    return `${payload.browserName} URL`;
  }
  if (payload.urlHost) {
    return "ブラウザ URL";
  }
  if (payload.source === "browser") {
    return "ブラウザ URL";
  }
  if (payload.source === "app") {
    return "アプリ";
  }
  return "検知";
}
