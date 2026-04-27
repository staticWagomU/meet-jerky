import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "@tanstack/react-router";
import type { MeetingAppDetectedPayload } from "../types";
import { toErrorMessage } from "../utils/errorMessage";

/// 会議アプリまたはブラウザ会議URLを検知したら、画面上部にバナーを出して
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
  const navigate = useNavigate();

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

  if (!detected && !listenerError) return null;

  const displayName = detected ? getMeetingDetectedDisplayName(detected) : null;
  const sourceLabel = detected ? getMeetingDetectedSourceLabel(detected) : null;
  const bannerMessage = listenerError
    ? listenerError
    : `${displayName} を検出しました。自動録音は開始していません。録音と文字起こしの状態を確認できます。`;
  const bannerAriaLabel = listenerError
    ? listenerError
    : `${displayName} を検出しました。${
        sourceLabel ? `検知元 ${sourceLabel}。` : ""
      }自動録音は開始していません。録音と文字起こしの状態を確認できます。`;
  const confirmRecordingLabel = detected
    ? `${displayName} の録音と文字起こしの状態を確認`
    : "録音と文字起こしの状態を確認";
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
      {sourceLabel && (
        <span
          className="meeting-detected-source-badge"
          aria-label={`検知元: ${sourceLabel}`}
          title={`検知元: ${sourceLabel}`}
        >
          {sourceLabel}
        </span>
      )}
      <span className="meeting-detected-banner-text">{bannerMessage}</span>
      {(detected || listenerError) && (
        <div className="meeting-detected-banner-actions">
          {detected && (
            <button
              type="button"
              className="control-btn control-btn-transcribe"
              aria-label={confirmRecordingLabel}
              title={confirmRecordingLabel}
              onClick={() => {
                navigate({ to: "/" });
                setDetected(null);
              }}
            >
              状態を確認
            </button>
          )}
          <button
            type="button"
            className="control-btn control-btn-clear"
            aria-label={dismissBannerLabel}
            title={dismissBannerLabel}
            onClick={() => {
              setDetected(null);
              setListenerError(null);
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
    return "ブラウザURL";
  }
  if (payload.source === "browser") {
    return "ブラウザURL";
  }
  if (payload.source === "app") {
    return "アプリ";
  }
  return "検知";
}
