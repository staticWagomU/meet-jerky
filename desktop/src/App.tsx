import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { toErrorMessage } from "./utils/errorMessage";
import {
  markPendingMeetingStartRequest,
  MEETING_START_REQUEST_EVENT,
  readMeetingStartRequestPayload,
  readPendingMeetingStartRequest,
} from "./utils/meetingStartRequest";
import "./App.css";
const SHOW_MAIN_WINDOW_REQUEST_EVENT = "meet-jerky-show-main-requested";

const APP_SHELL_FLOW_ITEMS = [
  {
    code: "DET",
    label: "検知",
  },
  {
    code: "REC",
    label: "録音",
  },
  {
    code: "NOTE",
    label: "ノート",
  },
  {
    code: "LOG",
    label: "履歴",
  },
];

function formatShellError(message: string): string {
  return message;
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
          const message = formatShellError("メインを表示できませんでした。");
          console.error(
            "メインウィンドウの表示に失敗しました:",
            toErrorMessage(e),
          );
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
        setShellError(formatShellError("メイン表示を準備できませんでした。"));
      }
      console.error(
        "メイン表示要求の受信開始に失敗しました:",
        toErrorMessage(e),
      );
      return null;
    });
    const unlistenStartPromise = listen<unknown>(
      MEETING_START_REQUEST_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        if (!readPendingMeetingStartRequest()) {
          markPendingMeetingStartRequest(
            readMeetingStartRequestPayload(event.payload),
          );
        }
        showMainTranscriptWindow();
      },
    ).catch((e) => {
      if (!disposed) {
        setShellError(formatShellError("録音開始を準備できませんでした。"));
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
          console.error(
            "メイン表示要求の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
      unlistenStartPromise
        .then((unlisten) => {
          if (unlisten) {
            unlisten();
          }
        })
        .catch((e) => {
          console.error(
            "録音開始要求の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, [navigate]);

  return (
    <main
      className="container app-shell"
      data-tauri-drag-region
      aria-label="Meet Jerky メニューバーウィンドウ"
      title="Meet Jerky メニューバーウィンドウ"
    >
      <header
        className="app-shell-status"
        aria-label="録音までの導線"
        data-tauri-drag-region
      >
        <div className="app-shell-status-brand" data-tauri-drag-region>
          <span className="app-shell-status-kicker" data-tauri-drag-region>
            Meet Jerky
          </span>
          <strong data-tauri-drag-region>録音を忘れない</strong>
        </div>
        <ol className="app-shell-status-rail" aria-label="主要導線">
          {APP_SHELL_FLOW_ITEMS.map((item) => (
            <li
              key={item.code}
              className="app-shell-status-item"
              aria-label={`${item.label} 導線`}
              data-tauri-drag-region
            >
              <span
                className="app-shell-status-item-code"
                data-tauri-drag-region
              >
                {item.code}
              </span>
              <span
                className="app-shell-status-item-label"
                data-tauri-drag-region
              >
                {item.label}
              </span>
            </li>
          ))}
        </ol>
      </header>
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
