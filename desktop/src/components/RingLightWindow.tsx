import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isLiveCaptionStatusPayload,
  LIVE_CAPTION_STATUS_EVENT,
  getTransmissionStatusAriaLabel,
  getVisibleTransmissionLabel,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import {
  isRingLightModePayload,
  RING_LIGHT_MODE_EVENT,
  type RingLightMode,
} from "../utils/ringLight";
import { isTauriRuntime } from "../utils/browserRuntime";
import { PREVIEW_LIVE_CAPTION_STATUS } from "../utils/previewAppData";

export function RingLightWindow() {
  const isBrowserPreview = !isTauriRuntime();
  const [mode, setMode] = useState<RingLightMode>("soft");
  const [status, setStatus] = useState<LiveCaptionStatusPayload>(() =>
    isBrowserPreview
      ? PREVIEW_LIVE_CAPTION_STATUS
      : readStoredLiveCaptionStatus((e) => {
          console.error("リングライトの録音状態読み取りに失敗しました:", e);
        }),
  );

  useEffect(() => {
    if (isBrowserPreview) {
      setStatus(PREVIEW_LIVE_CAPTION_STATUS);
      return;
    }
    let disposed = false;
    const modeUnlistenPromise = listen<unknown>(
      RING_LIGHT_MODE_EVENT,
      (event) => {
        if (disposed || !isRingLightModePayload(event.payload)) {
          return;
        }
        setMode(event.payload.mode === "off" ? "soft" : event.payload.mode);
      },
    ).catch((e) => {
      console.error("リングライト設定の受信開始に失敗しました:", e);
      return null;
    });
    const statusUnlistenPromise = listen<unknown>(
      LIVE_CAPTION_STATUS_EVENT,
      (event) => {
        if (disposed || !isLiveCaptionStatusPayload(event.payload)) {
          return;
        }
        setStatus(normalizeLiveCaptionStatusPayload(event.payload));
      },
    ).catch((e) => {
      console.error("リングライトの録音状態受信開始に失敗しました:", e);
      return null;
    });

    return () => {
      disposed = true;
      modeUnlistenPromise
        .then((unlisten) => {
          if (unlisten) {
            unlisten();
          }
        })
        .catch((e) => {
          console.error("リングライト設定の受信解除に失敗しました:", e);
        });
      statusUnlistenPromise
        .then((unlisten) => {
          if (unlisten) {
            unlisten();
          }
        })
        .catch((e) => {
          console.error("リングライトの録音状態受信解除に失敗しました:", e);
        });
    };
  }, [isBrowserPreview]);

  const ringLightTrackLabel = `自分 ${status.microphoneTrackLabel} / 相手側 ${status.systemAudioTrackLabel}`;
  const ringLightTransmissionLabel = getVisibleTransmissionLabel(status);
  const ringLightTransmissionAriaLabel = getTransmissionStatusAriaLabel(status);
  const ringLightStorageLabel =
    "このMacに保存。録音履歴、文字起こし、音声トラックをローカル保存";
  const ringLightNotesLabel =
    "翻訳切替、AIノート、質問はライブ文字起こしウィンドウで確認。質問はここでは未送信";
  const persistentRecordingIndicatorLabel =
    "録音中であることを忘れないための常駐RECインジケーター";
  const ringLightStatusLabel = `${persistentRecordingIndicatorLabel}。${ringLightTrackLabel}。${ringLightStorageLabel}。${ringLightNotesLabel}。文字起こし ${status.transcriptionStatusLabel}。${ringLightTransmissionAriaLabel}。`;
  const openLiveCaptionLabel = `ライブ文字起こしを表示。常駐REC表示中、${ringLightTrackLabel}、${ringLightStorageLabel}、${ringLightNotesLabel}、${ringLightTransmissionAriaLabel}。`;
  const showLiveCaptionWindow = () => {
    if (isBrowserPreview) {
      return;
    }
    void invoke("set_live_caption_window_visible", { visible: true }).catch(
      (e) => {
        console.error("ライブ文字起こしウィンドウを表示できませんでした:", e);
      },
    );
  };

  return (
    <div
      className={`ring-light-window ring-light-window-${mode}`}
      role="status"
      aria-live="polite"
      aria-label={ringLightStatusLabel}
      title={ringLightStatusLabel}
      data-tauri-drag-region
    >
      <div className="ring-light-edge ring-light-edge-top" />
      <div className="ring-light-edge ring-light-edge-right" />
      <div className="ring-light-edge ring-light-edge-bottom" />
      <div className="ring-light-edge ring-light-edge-left" />
      <div className="ring-light-badge" data-tauri-drag-region>
        <span className="ring-light-badge-dot" aria-hidden="true" />
        <span className="ring-light-badge-copy" data-tauri-drag-region>
          <strong data-tauri-drag-region>REC</strong>
          <small data-tauri-drag-region>
            常駐表示 · 文字起こし {status.transcriptionStatusLabel}
          </small>
        </span>
        <span
          className="ring-light-ai-pill"
          data-tauri-drag-region
          aria-label={ringLightTransmissionAriaLabel}
          title={ringLightTransmissionAriaLabel}
        >
          {ringLightTransmissionLabel}
        </span>
        <span
          className="ring-light-track-pill"
          data-tauri-drag-region
          aria-label={ringLightTrackLabel}
          title={ringLightTrackLabel}
        >
          {ringLightTrackLabel}
        </span>
        <span
          className="ring-light-storage-pill"
          data-tauri-drag-region
          aria-label={ringLightStorageLabel}
          title={ringLightStorageLabel}
        >
          このMacに保存
        </span>
        <span
          className="ring-light-notes-pill"
          data-tauri-drag-region
          aria-label={ringLightNotesLabel}
          title={ringLightNotesLabel}
        >
          翻訳/AI: ライブ内
        </span>
        <button
          type="button"
          className="ring-light-open-caption"
          onClick={showLiveCaptionWindow}
          aria-label={openLiveCaptionLabel}
          title={openLiveCaptionLabel}
        >
          文字起こしを表示
        </button>
      </div>
    </div>
  );
}
