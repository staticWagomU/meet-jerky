import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { markPendingMeetingStartRequest } from "./utils/meetingStartRequest";
import {
  getNextRingLightMode,
  RING_LIGHT_MODE_EVENT,
  type RingLightMode,
} from "./utils/ringLight";
import "./App.css";

const MEETING_START_REQUEST_EVENT = "meet-jerky-start-recording-requested";
const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";

function App() {
  const navigate = useNavigate();
  const [ringLightMode, setRingLightMode] = useState<RingLightMode>("off");
  const [ringLightError, setRingLightError] = useState<string | null>(null);
  const [isRingLightPending, setIsRingLightPending] = useState(false);

  useEffect(() => {
    let disposed = false;
    const showMainTranscriptWindow = () => {
      void invoke("show_main_window").catch((e) => {
        console.error("メインウィンドウの表示に失敗しました:", e);
      });
      void navigate({ to: "/" });
    };
    const unlistenShowPromise = listen(SHOW_MAIN_WINDOW_REQUEST_EVENT, () => {
      if (!disposed) {
        showMainTranscriptWindow();
      }
    });
    const unlistenStartPromise = listen(MEETING_START_REQUEST_EVENT, () => {
      if (disposed) {
        return;
      }
      markPendingMeetingStartRequest();
      showMainTranscriptWindow();
    });

    return () => {
      disposed = true;
      unlistenShowPromise
        .then((unlisten) => unlisten())
        .catch((e) => {
          console.error("メイン表示要求の受信解除に失敗しました:", e);
        });
      unlistenStartPromise
        .then((unlisten) => unlisten())
        .catch((e) => {
          console.error("録音開始要求の受信解除に失敗しました:", e);
        });
    };
  }, [navigate]);

  const cycleRingLightMode = () => {
    if (isRingLightPending) {
      return;
    }
    const previousMode = ringLightMode;
    const nextMode = getNextRingLightMode(ringLightMode);
    setRingLightMode(nextMode);
    setRingLightError(null);
    setIsRingLightPending(true);
    void (async () => {
      try {
        await invoke("set_ring_light_visible", { visible: nextMode !== "off" });
        setRingLightError(null);
        try {
          await emit(RING_LIGHT_MODE_EVENT, { mode: nextMode });
        } catch (e) {
          setRingLightError("リングライトの明るさを反映できませんでした");
          console.error("リングライト設定の送信に失敗しました:", e);
        }
      } catch (e) {
        setRingLightMode(previousMode);
        setRingLightError("リングライトを切り替えられませんでした");
        console.error("リングライト表示の切り替えに失敗しました:", e);
      } finally {
        setIsRingLightPending(false);
      }
    })();
  };
  let ringLightLabel = "リングライトを弱で表示する";
  let ringLightButtonText = "照明 オフ";
  const ringLightOperationNote =
    "表示中も背後のアプリ操作を妨げません";
  if (isRingLightPending) {
    ringLightLabel = "リングライトを切り替え中";
    ringLightButtonText = "照明 切替中...";
  } else if (ringLightMode === "soft") {
    ringLightLabel = "リングライトを強にする";
    ringLightButtonText = "照明 弱";
  } else if (ringLightMode === "bright") {
    ringLightLabel = "リングライトを消す";
    ringLightButtonText = "照明 強";
  }

  return (
    <main className="container app-shell">
      <header
        className="app-header"
        data-tauri-drag-region
        aria-label="meet-jerky メニューバーウィンドウ"
        title="meet-jerky メニューバーウィンドウ"
      >
        <div className="app-header-copy" data-tauri-drag-region>
          <span className="app-kicker" data-tauri-drag-region>
            meet-jerky
          </span>
          <h1 data-tauri-drag-region>会議の記録</h1>
        </div>
        <div className="app-header-actions">
          <button
            type="button"
            className={`app-header-light-toggle${
              ringLightMode !== "off" ? " app-header-light-toggle-active" : ""
            }`}
            aria-pressed={ringLightMode !== "off"}
            aria-label={`${ringLightLabel}。${ringLightOperationNote}`}
            title={`${ringLightLabel}。${ringLightOperationNote}。`}
            onClick={cycleRingLightMode}
            disabled={isRingLightPending}
          >
            {ringLightButtonText}
          </button>
          <span
            className="app-header-status"
            data-tauri-drag-region
            aria-label="メニューバー常駐中"
            title="メニューバー常駐中"
          >
            常駐中
          </span>
          {ringLightError && (
            <span
              className="app-header-light-error"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={ringLightError}
              title={ringLightError}
            >
              {ringLightError}
            </span>
          )}
        </div>
      </header>
      <nav className="nav app-nav" aria-label="主要ナビゲーション">
        <Link
          to="/"
          className="nav-link"
          title="リアルタイム文字起こし"
          activeProps={{ "aria-current": "page" }}
        >
          文字起こし
        </Link>
        <Link
          to="/sessions"
          className="nav-link"
          title="保存済みセッション履歴"
          activeProps={{ "aria-current": "page" }}
        >
          履歴
        </Link>
        <Link
          to="/settings"
          className="nav-link"
          title="アプリ設定と権限状態"
          activeProps={{ "aria-current": "page" }}
        >
          設定
        </Link>
      </nav>
      <section className="app-content" aria-label="現在の画面">
        <Outlet />
      </section>
    </main>
  );
}

export default App;
