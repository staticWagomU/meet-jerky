import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { markPendingMeetingStartRequest, MEETING_START_REQUEST_EVENT } from "./utils/meetingStartRequest";
import "./App.css";
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
    }).catch((e) => {
      console.error("メイン表示要求の受信開始に失敗しました:", e);
      return null;
    });
    const unlistenStartPromise = listen(MEETING_START_REQUEST_EVENT, () => {
      if (disposed) {
        return;
      }
      markPendingMeetingStartRequest();
      showMainTranscriptWindow();
    }).catch((e) => {
      console.error("録音開始要求の受信開始に失敗しました:", e);
      return null;
    });

    return () => {
      disposed = true;
      unlistenShowPromise
        .then((unlisten) => {
          if (unlisten) {
            unlisten();
          }
        })
        .catch((e) => {
          console.error("メイン表示要求の受信解除に失敗しました:", e);
        });
      unlistenStartPromise
        .then((unlisten) => {
          if (unlisten) {
            unlisten();
          }
        })
        .catch((e) => {
          console.error("録音開始要求の受信解除に失敗しました:", e);
        });
    };
  }, [navigate]);

  return (
    <main
      className="container app-shell"
      data-tauri-drag-region
      aria-label="meet-jerky メニューバーウィンドウ"
      title="meet-jerky メニューバーウィンドウ"
    >
      <section className="app-content" aria-label="現在の画面">
        <Outlet />
      </section>
    </main>
  );
}

export default App;
