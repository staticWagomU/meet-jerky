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
    const nextMode = getNextRingLightMode(ringLightMode);
    setRingLightMode(nextMode);
    void invoke("set_ring_light_visible", { visible: nextMode !== "off" })
      .then(() => emit(RING_LIGHT_MODE_EVENT, { mode: nextMode }))
      .catch((e) => {
        setRingLightMode(ringLightMode);
        console.error("リングライト表示の切り替えに失敗しました:", e);
      });
  };
  const ringLightLabel =
    ringLightMode === "off"
      ? "リングライトを弱で表示する"
      : ringLightMode === "soft"
        ? "リングライトを強にする"
        : "リングライトを消す";
  const ringLightButtonText =
    ringLightMode === "off"
      ? "ライト"
      : ringLightMode === "soft"
        ? "ライト 弱"
        : "ライト 強";

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
            aria-label={ringLightLabel}
            title={`${ringLightLabel}。クリック操作は透過します。`}
            onClick={cycleRingLightMode}
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
