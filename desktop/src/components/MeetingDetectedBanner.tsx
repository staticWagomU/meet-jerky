import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "@tanstack/react-router";
import type { MeetingAppDetectedPayload } from "../types";

function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/// Zoom / Teams 等の起動を検知したら、画面上部にバナーを出して
/// ユーザーに記録開始を促すグローバルコンポーネント。
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

  return (
    <div
      className="meeting-detected-banner"
      role={listenerError ? "alert" : "status"}
    >
      <span className="meeting-detected-banner-text">
        {listenerError ??
          `${displayName} を検出しました。文字起こしページで記録状態を確認できます。`}
      </span>
      {detected && (
        <div className="meeting-detected-banner-actions">
          <button
            type="button"
            className="control-btn control-btn-transcribe"
            onClick={() => {
              navigate({ to: "/" });
              setDetected(null);
            }}
          >
            記録状態を確認
          </button>
          <button
            type="button"
            className="control-btn control-btn-clear"
            aria-label="閉じる"
            onClick={() => setDetected(null)}
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
