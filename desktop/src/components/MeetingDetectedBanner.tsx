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
  const [isActionPending, setIsActionPending] = useState(false);

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
          setIsActionPending(false);
          setListenerError("会議検知通知の形式が不正です。");
          return;
        }
        setListenerError(null);
        setIsActionPending(false);
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
            setStatusPayload(normalizeLiveCaptionStatusPayload(event.payload));
          }
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
    if (!detected || listenerError || isActionPending) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      clearPendingMeetingStartRequest();
      setIsActionPending(false);
      setDetected(null);
      void getCurrentWindow().hide();
    }, PROMPT_AUTO_HIDE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [detected, listenerError, isActionPending]);

  if (!detected && !listenerError) return null;

  const displayName = detected ? getMeetingDetectedDisplayName(detected) : null;
  const sourceLabel = detected ? getMeetingDetectedSourceLabel(detected) : null;
  const visibleTransmissionLabel = getVisibleTransmissionLabel(statusPayload);
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
      }文字起こしエンジン ${statusPayload.engineLabel}。外部送信 ${statusPayload.aiTransmissionLabel}。自分/相手側トラックの録音と文字起こしの状態を確認してください。約${PROMPT_AUTO_HIDE_SECONDS}秒後に自動で隠れます。`;
  const confirmRecordingLabel = detected
    ? isActionPending
      ? `${displayName} の録音状態確認画面を開いています`
      : `${displayName} の録音と文字起こしの状態を確認`
    : "録音と文字起こしの状態を確認";
  const startRecordingLabel = detected
    ? isActionPending
      ? `${displayName} の録音開始要求を送信中`
      : `${displayName} の録音と文字起こしを開始`
    : "録音と文字起こしを開始";
  const dismissBannerLabel = "会議検知バナーを閉じる";
  const bannerRole = listenerError ? "alert" : "status";
  const bannerClassName = listenerError
    ? "meeting-detected-banner meeting-detected-banner-error"
    : "meeting-detected-banner";
  const handleStartRecording = async () => {
    if (isActionPending) {
      return;
    }
    setIsActionPending(true);
    markPendingMeetingStartRequest();
    try {
      await emit(MEETING_START_REQUEST_EVENT);
      await getCurrentWindow().hide();
      setDetected(null);
    } catch (e) {
      clearPendingMeetingStartRequest();
      setDetected(null);
      setIsActionPending(false);
      setListenerError(`録音開始要求の送信に失敗しました: ${toErrorMessage(e)}`);
    }
  };
  const handleConfirmRecordingState = async () => {
    if (isActionPending) {
      return;
    }
    setIsActionPending(true);
    clearPendingMeetingStartRequest();
    try {
      await emit(SHOW_MAIN_WINDOW_REQUEST_EVENT);
      await getCurrentWindow().hide();
      setDetected(null);
    } catch (e) {
      setDetected(null);
      setIsActionPending(false);
      setListenerError(`録音状態確認画面の表示要求に失敗しました: ${toErrorMessage(e)}`);
    }
  };
  const handleDismissBanner = async () => {
    clearPendingMeetingStartRequest();
    setDetected(null);
    setListenerError(null);
    setIsActionPending(false);
    try {
      await getCurrentWindow().hide();
    } catch (e) {
      console.error("会議検知バナーを隠せませんでした:", toErrorMessage(e));
    }
  };

  return (
    <div
      className={bannerClassName}
      role={bannerRole}
      aria-live={bannerRole === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={bannerAriaLabel}
      title={bannerAriaLabel}
    >
      {!listenerError && (
        <div className="meeting-detected-attention-mark" aria-hidden="true">
          <span className="meeting-detected-attention-dot" />
        </div>
      )}
      {sourceLabel && (
        <span
          className="meeting-detected-source-badge"
          aria-label={`検知元: ${sourceLabel}`}
          title={`検知元: ${sourceLabel}`}
        >
          {sourceLabel}
        </span>
      )}
      {!listenerError && (
        <>
          <span
            className="meeting-detected-source-badge meeting-detected-engine-badge"
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
            aria-label={`外部送信: ${statusPayload.aiTransmissionLabel}`}
            title={`外部送信: ${statusPayload.aiTransmissionLabel}`}
          >
            {visibleTransmissionLabel}
          </span>
        </>
      )}
      <span className="meeting-detected-banner-text">
        <span className="meeting-detected-banner-title">{bannerTitle}</span>
        {bannerDetail && (
          <span className="meeting-detected-banner-detail">
            {bannerDetail}
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
                disabled={isActionPending}
                aria-label={startRecordingLabel}
                title={startRecordingLabel}
                onClick={() => {
                  void handleStartRecording();
                }}
              >
                記録を開始
              </button>
              <button
                type="button"
                className="control-btn control-btn-clear"
                disabled={isActionPending}
                aria-label={confirmRecordingLabel}
                title={confirmRecordingLabel}
                onClick={() => {
                  void handleConfirmRecordingState();
                }}
              >
                状態を確認
              </button>
            </>
          )}
          <button
            type="button"
            className="control-btn control-btn-clear"
            disabled={isActionPending}
            aria-label={dismissBannerLabel}
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
