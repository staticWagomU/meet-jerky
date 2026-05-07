import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { toErrorMessage } from "./utils/errorMessage";
import {
  markPendingMeetingStartRequest,
  MEETING_START_REQUEST_EVENT,
} from "./utils/meetingStartRequest";
import "./App.css";
const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";

function formatShellError(message: string, error: unknown): string {
  return `${message}（詳細: ${toErrorMessage(error)}）`;
}

function App() {
  const navigate = useNavigate();
  const [shellError, setShellError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const showMainTranscriptWindow = () => {
      void invoke("show_main_window")
        .then(() => {
          if (!disposed) {
            setShellError(null);
          }
        })
        .catch((e) => {
          const message = formatShellError(
            "メインウィンドウの表示に失敗しました。",
            e,
          );
          console.error("メインウィンドウの表示に失敗しました:", toErrorMessage(e));
          if (!disposed) {
            setShellError(message);
          }
        });
      void navigate({ to: "/" });
    };
    const unlistenShowPromise = listen(SHOW_MAIN_WINDOW_REQUEST_EVENT, () => {
      if (!disposed) {
        showMainTranscriptWindow();
      }
    }).catch((e) => {
      if (!disposed) {
        setShellError(
          formatShellError("メイン表示要求の受信開始に失敗しました。", e),
        );
      }
      console.error("メイン表示要求の受信開始に失敗しました:", toErrorMessage(e));
      return null;
    });
    const unlistenStartPromise = listen(MEETING_START_REQUEST_EVENT, () => {
      if (disposed) {
        return;
      }
      markPendingMeetingStartRequest();
      showMainTranscriptWindow();
    }).catch((e) => {
      if (!disposed) {
        setShellError(
          formatShellError("録音開始要求の受信開始に失敗しました。", e),
        );
      }
      console.error("録音開始要求の受信開始に失敗しました:", toErrorMessage(e));
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
          console.error("メイン表示要求の受信解除に失敗しました:", toErrorMessage(e));
        });
      unlistenStartPromise
        .then((unlisten) => {
          if (unlisten) {
            unlisten();
          }
        })
        .catch((e) => {
          console.error("録音開始要求の受信解除に失敗しました:", toErrorMessage(e));
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
      {shellError && (
        <div
          className="app-shell-alert"
          role="alert"
          aria-live="assertive"
          data-tauri-drag-region
        >
          <p>{shellError}</p>
          <button
            type="button"
            className="app-shell-alert-close"
            aria-label="シェルエラーを閉じる"
            title="シェルエラーを閉じる"
            onClick={() => {
              setShellError(null);
            }}
          >
            閉じる
          </button>
        </div>
      )}
      <section className="app-content" aria-label="現在の画面">
        <Outlet />
      </section>
    </main>
  );
}

export default App;
