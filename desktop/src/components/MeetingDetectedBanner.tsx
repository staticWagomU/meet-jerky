import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MeetingAppDetectedPayload } from "../types";
import { toErrorMessage } from "../utils/errorMessage";

const MEETING_START_REQUEST_EVENT = "meet-jerky-start-recording-requested";
const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";
const PENDING_MEETING_START_STORAGE_KEY = "meetJerky.pendingMeetingStart";
const PROMPT_AUTO_HIDE_MS = 15000;
const PROMPT_AUTO_HIDE_SECONDS = PROMPT_AUTO_HIDE_MS / 1000;

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
  const [listenerError, setListenerError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<MeetingAppDetectedPayload>(
      "meeting-app-detected",
      (e) => {
        if (disposed) {
          return;
        }
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

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error("会議検知通知の受信解除に失敗しました:", toErrorMessage(e));
        });
    };
  }, []);

  useEffect(() => {
    if (!detected || listenerError) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setDetected(null);
      void getCurrentWindow().hide();
    }, PROMPT_AUTO_HIDE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [detected, listenerError]);

  if (!detected && !listenerError) return null;

  const displayName = detected ? getMeetingDetectedDisplayName(detected) : null;
  const sourceLabel = detected ? getMeetingDetectedSourceLabel(detected) : null;
  const bannerTitle = listenerError
    ? listenerError
    : "録音しますか？";
  const bannerDetail = listenerError
    ? null
    : `${displayName} を検出しました。自分/相手側トラックの録音と文字起こしはまだ開始していません。約${PROMPT_AUTO_HIDE_SECONDS}秒後に自動で隠れます。`;
  const bannerAriaLabel = listenerError
    ? listenerError
    : `${displayName} を検出しました。${
        sourceLabel ? `検知元 ${sourceLabel}。` : ""
      }自分/相手側トラックの録音と文字起こしはまだ開始していません。開始前に状態を確認してください。約${PROMPT_AUTO_HIDE_SECONDS}秒後に自動で隠れます。`;
  const confirmRecordingLabel = detected
    ? `${displayName} の録音開始前の状態を確認`
    : "録音開始前の状態を確認";
  const startRecordingLabel = detected
    ? `${displayName} の録音と文字起こしを開始`
    : "録音と文字起こしを開始";
  const dismissBannerLabel = "会議検知バナーを閉じる";
  const bannerRole = listenerError ? "alert" : "status";
  const bannerClassName = listenerError
    ? "meeting-detected-banner meeting-detected-banner-error"
    : "meeting-detected-banner";

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
                aria-label={startRecordingLabel}
                title={startRecordingLabel}
                onClick={() => {
                  localStorage.setItem(PENDING_MEETING_START_STORAGE_KEY, "1");
                  void emit(MEETING_START_REQUEST_EVENT);
                  void getCurrentWindow().hide();
                  setDetected(null);
                }}
              >
                録音を開始
              </button>
              <button
                type="button"
                className="control-btn control-btn-clear"
                aria-label={confirmRecordingLabel}
                title={confirmRecordingLabel}
                onClick={() => {
                  void emit(SHOW_MAIN_WINDOW_REQUEST_EVENT);
                  void getCurrentWindow().hide();
                  setDetected(null);
                }}
              >
                状態を確認
              </button>
            </>
          )}
          <button
            type="button"
            className="control-btn control-btn-clear"
            aria-label={dismissBannerLabel}
            title={dismissBannerLabel}
            onClick={() => {
              setDetected(null);
              setListenerError(null);
              void getCurrentWindow().hide();
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
