import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Captions, Video } from "lucide-react";
import type { MeetingAppDetectedPayload } from "../types";
import {
  clearPendingMeetingStartRequest,
  markPendingMeetingStartRequest,
  MEETING_START_REQUEST_EVENT,
} from "../utils/meetingStartRequest";
import {
  getMeetingDetectedBannerDetail,
  getMeetingDetectedDisplayName,
  getMeetingDetectedSourceLabel,
} from "../utils/meetingDetectedBannerHelpers";
import {
  isMeetingAppDetectedPayload,
  MEETING_APP_DETECTED_EVENT,
} from "../utils/meetingDetection";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getTransmissionStatusAriaLabel,
  isLiveCaptionStatusPayload,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import { BOTH_TRACKS_DEVICE_LABEL } from "../utils/audioTrackLabels";

const PROMPT_AUTO_HIDE_MS = 15000;
const PROMPT_AUTO_HIDE_SECONDS = PROMPT_AUTO_HIDE_MS / 1000;
const PROMPT_EMPTY_BOOT_HIDE_MS = 2000;
const INVALID_MEETING_DETECTION_PAYLOAD_ERROR =
  "会議検知通知の形式が不正です。";
const INVALID_STATUS_PAYLOAD_ERROR =
  "会議検知プロンプトの状態通知の形式が不正です。";
const PROMPT_OPERATION_LABEL =
  "「記録を開始」を選ぶまで録音は開始しません。バナーはドラッグで移動でき、Escape キーで閉じられます";
type PendingPromptAction = "start" | null;

async function hideMeetingPromptWindow(): Promise<void> {
  await invoke("set_meeting_prompt_window_visible", { visible: false });
}

async function showMeetingPromptWindow(): Promise<void> {
  await invoke("set_meeting_prompt_window_visible", { visible: true });
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
  const hasReceivedPromptContentRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const applyMeetingDetectionPayload = (
      payload: MeetingAppDetectedPayload,
    ) => {
      hasReceivedPromptContentRef.current = true;
      setListenerError(null);
      setPendingAction(null);
      setStatusPayload(readPromptLiveCaptionStatus());
      setDetected(payload);
    };
    const recoverLatestMeetingDetection = async () => {
      const payload = await invoke<unknown>("take_latest_meeting_detection");
      if (disposed || payload == null) {
        return;
      }
      if (!isMeetingAppDetectedPayload(payload)) {
        hasReceivedPromptContentRef.current = true;
        setDetected(null);
        setPendingAction(null);
        setListenerError(INVALID_MEETING_DETECTION_PAYLOAD_ERROR);
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
        setPendingAction(null);
        setListenerError(INVALID_MEETING_DETECTION_PAYLOAD_ERROR);
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
          setDetected(null);
          setPendingAction(null);
          setListenerError(INVALID_MEETING_DETECTION_PAYLOAD_ERROR);
          return;
        }
        applyMeetingDetectionPayload(e.payload);
        void consumeLatestMeetingDetection(e.payload).catch((e) => {
          const msg = toErrorMessage(e);
          console.error("受信済み会議検知通知の消費に失敗しました:", msg);
          if (!disposed) {
            setListenerError(
              `受信済み会議検知通知の消費に失敗しました: ${msg}`,
            );
          }
        });
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setListenerError((current) =>
            current?.startsWith("会議検知通知の受信開始に失敗しました:")
              ? null
              : current,
          );
          void recoverLatestMeetingDetection().catch((e) => {
            const msg = toErrorMessage(e);
            console.error("最新の会議検知通知の回収に失敗しました:", msg);
            if (!disposed) {
              hasReceivedPromptContentRef.current = true;
              setDetected(null);
              setPendingAction(null);
              setListenerError(
                `最新の会議検知通知の回収に失敗しました: ${msg}`,
              );
            }
          });
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
          if (!hasReceivedPromptContentRef.current) {
            setListenerError(null);
            void hideMeetingPromptWindow().catch((e) => {
              console.error(
                "会議検知前の不正な文字起こしステータス通知によるプロンプト非表示に失敗しました:",
                toErrorMessage(e),
              );
            });
            return;
          }
          setListenerError(INVALID_STATUS_PAYLOAD_ERROR);
        }
      },
    ).catch((e) => {
      if (!disposed) {
        const msg = toErrorMessage(e);
        console.error(
          "会議検知プロンプトの文字起こしステータス受信開始に失敗しました:",
          msg,
        );
        setListenerError(
          `会議検知プロンプトの文字起こしステータス受信開始に失敗しました: ${msg}`,
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
  }, []);

  useEffect(() => {
    if (!detected && !(listenerError && hasReceivedPromptContentRef.current)) {
      return;
    }
    void showMeetingPromptWindow().catch((e) => {
      console.error("会議検知プロンプトの表示に失敗しました:", toErrorMessage(e));
    });
  }, [detected, listenerError]);

  useEffect(() => {
    if (!detected || listenerError || pendingAction) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void hideMeetingPromptWindow()
        .then(() => {
          clearPendingMeetingStartRequest();
          setPendingAction(null);
          setDetected(null);
        })
        .catch((e) => {
          const msg = toErrorMessage(e);
          console.error("会議検知バナーの自動非表示に失敗しました:", msg);
          setListenerError(
            `会議検知バナーの自動非表示に失敗しました: ${msg}`,
          );
        });
    }, PROMPT_AUTO_HIDE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [detected, listenerError, pendingAction]);

  const displayName = detected ? getMeetingDetectedDisplayName(detected) : null;
  const bannerDisplayName = displayName ?? detected?.appName ?? "";
  const sourceLabel = detected ? getMeetingDetectedSourceLabel(detected) : null;
  const transmissionAriaLabel = getTransmissionStatusAriaLabel(statusPayload);
  const bannerTitle = listenerError
    ? listenerError
    : "会議を検知しました";
  const bannerDetail = listenerError
    ? null
    : detected
      ? getMeetingDetectedBannerDetail(detected, bannerDisplayName)
      : null;
  const bannerAriaLabel = listenerError
    ? listenerError
    : `${displayName} を検出しました。${
        sourceLabel ? `検知元 ${sourceLabel}。` : ""
      }${PROMPT_OPERATION_LABEL}。文字起こしエンジン ${statusPayload.engineLabel}。${transmissionAriaLabel}。${BOTH_TRACKS_DEVICE_LABEL} の録音と文字起こしの状態を確認してください。約${PROMPT_AUTO_HIDE_SECONDS}秒後に自動で隠れます。`;
  const startRecordingLabel = detected
    ? pendingAction === "start"
      ? `${displayName} の録音開始要求を送信中`
      : `${displayName} の ${BOTH_TRACKS_DEVICE_LABEL} の録音と文字起こしを開始`
    : "録音と文字起こしを開始";
  const dismissBannerLabel = pendingAction
    ? "操作中のため会議検知バナーを閉じられません"
    : "会議検知バナーを閉じる。Escape キーでも閉じられます。録音は開始しません";
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
    } catch (e) {
      clearPendingMeetingStartRequest();
      setPendingAction(null);
      const msg = toErrorMessage(e);
      console.error("録音開始要求の送信に失敗しました:", msg);
      setListenerError(`録音開始要求の送信に失敗しました: ${msg}`);
      return;
    }
    try {
      await hideMeetingPromptWindow();
      setDetected(null);
    } catch (e) {
      setPendingAction(null);
      const msg = toErrorMessage(e);
      console.error("会議検知バナーを隠せませんでした:", msg);
      setListenerError(`会議検知バナーを隠せませんでした: ${msg}`);
    }
  };
  const handleDismissBanner = async () => {
    try {
      await hideMeetingPromptWindow();
      clearPendingMeetingStartRequest();
      setDetected(null);
      setListenerError(null);
      setPendingAction(null);
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
    <>
      <div
        className={bannerClassName}
        data-tauri-drag-region
        role={bannerRole}
        aria-live={bannerRole === "alert" ? "assertive" : "polite"}
        aria-atomic="true"
        aria-label={bannerAriaLabel}
        title={bannerAriaLabel}
      >
      <span className="meeting-detected-ribbon" aria-hidden="true" />
      {!listenerError && (
        <span className="meeting-detected-banner-top" data-tauri-drag-region>
          <span
            className="meeting-detected-attention-mark"
            data-tauri-drag-region
            aria-hidden="true"
          >
            <Video
              className="meeting-detected-attention-icon"
              aria-hidden="true"
              size={18}
              strokeWidth={2.2}
            />
          </span>
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
          </span>
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
        </span>
      )}
      {!listenerError && (
        <>
          <span className="meeting-detected-track-grid" data-tauri-drag-region>
            <span
              className="meeting-detected-track-chip"
              data-tauri-drag-region
              aria-label="録音対象: Mic 自分"
              title="録音対象: Mic 自分"
            >
              <span className="meeting-detected-track-dot" aria-hidden="true" />
              Mic: 自分
            </span>
            <span
              className="meeting-detected-track-chip"
              data-tauri-drag-region
              aria-label="録音対象: System 相手側"
              title="録音対象: System 相手側"
            >
              <span className="meeting-detected-track-dot" aria-hidden="true" />
              System: 相手側
            </span>
          </span>
        </>
      )}
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
                <Captions
                  className="meeting-detected-start-icon"
                  aria-hidden="true"
                  size={15}
                  strokeWidth={2.4}
                />
                {pendingAction === "start" ? "開始要求中..." : "開始"}
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
            {listenerError ? "閉じる" : "今回はしない"}
          </button>
        </div>
      )}
      </div>
      <div
        className="meeting-detected-status-pill"
        data-tauri-drag-region
        aria-hidden="true"
      >
        <span aria-hidden="true" />
        記録状態を表示中
      </div>
    </>
  );
}
