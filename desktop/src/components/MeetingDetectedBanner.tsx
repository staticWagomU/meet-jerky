import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "@tanstack/react-router";
import type { MeetingAppDetectedPayload } from "../types";

/// Zoom / Teams 等の起動を検知したら、画面上部にバナーを出して
/// ユーザーに記録開始を促すグローバルコンポーネント。
///
/// 設計メモ:
/// - 自動で記録開始まで踏み込むと、TranscriptView のローカル状態 (mic / system
///   audio / engine) を外部から操作する必要があり、副作用の追跡が難しくなる。
/// - 本コンポーネントはあくまで導線の提示にとどめ、ユーザー操作で記録ボタンを
///   押してもらう。今後 TranscriptView 側に「auto-start ready」状態を持たせる
///   形で発展させやすいよう、`bundleId` / `appName` をペイロードとして保持する。
export function MeetingDetectedBanner() {
  const [detected, setDetected] = useState<MeetingAppDetectedPayload | null>(
    null,
  );
  const navigate = useNavigate();

  useEffect(() => {
    const unlistenPromise = listen<MeetingAppDetectedPayload>(
      "meeting-app-detected",
      (e) => {
        setDetected(e.payload);
      },
    );
    return () => {
      unlistenPromise.then((u) => u());
    };
  }, []);

  if (!detected) return null;

  return (
    <div className="meeting-detected-banner" role="status">
      <span className="meeting-detected-banner-text">
        {detected.appName} を検出しました。文字起こしを開始しますか?
      </span>
      <div className="meeting-detected-banner-actions">
        <button
          type="button"
          className="control-btn control-btn-transcribe"
          onClick={() => {
            navigate({ to: "/" });
            setDetected(null);
          }}
        >
          文字起こしページへ
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
    </div>
  );
}
