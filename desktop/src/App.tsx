import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { markPendingMeetingStartRequest } from "./utils/meetingStartRequest";
import "./App.css";

const MEETING_START_REQUEST_EVENT = "meet-jerky-start-recording-requested";
const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";

function App() {
  const navigate = useNavigate();

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

  return (
    <main className="container">
      <nav className="nav" aria-label="主要ナビゲーション">
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
      <Outlet />
    </main>
  );
}

export default App;
