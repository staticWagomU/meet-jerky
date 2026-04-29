import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TranscriptSegment } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getVisibleTransmissionLabel,
  isLiveCaptionStatusPayload,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import { formatSegmentTimestamp } from "../utils/timeFormat";
import {
  isTranscriptErrorSegment,
  isTranscriptSegmentPayload,
  isTranscriptionErrorPayload,
} from "../utils/transcriptSegment";

const WAITING_CAPTION_TEXT =
  "自分/相手側トラックの発話が確定するとここに表示されます。";
const INVALID_STATUS_PAYLOAD_ERROR =
  "ライブ字幕の状態通知の形式が不正です。";

type AudioSource = NonNullable<TranscriptSegment["source"]>;
type LatestBySource = Record<AudioSource, TranscriptSegment | null>;

const TRACKS: Array<{ source: AudioSource; label: string }> = [
  { source: "microphone", label: "自分" },
  { source: "system_audio", label: "相手側" },
];

function createEmptyLatestBySource(): LatestBySource {
  return {
    microphone: null,
    system_audio: null,
  };
}

function getSpeakerLabel(segment: TranscriptSegment): string {
  if (segment.source === "microphone") return "自分";
  if (segment.source === "system_audio") return "相手側";
  return segment.speaker || "ソース不明";
}

function getSpeakerClassName(segment: TranscriptSegment): string {
  if (segment.source === "microphone") {
    return "live-transcript-speaker live-transcript-speaker-self";
  }
  if (segment.source === "system_audio") {
    return "live-transcript-speaker live-transcript-speaker-other";
  }
  return "live-transcript-speaker live-transcript-speaker-unknown";
}

function getTrackStateLabel(
  segment: TranscriptSegment | null,
  captureLabel: string,
): string {
  if (!segment) {
    return captureLabel;
  }
  if (isTranscriptErrorSegment(segment)) {
    return `${captureLabel}・エラー`;
  }
  return `${captureLabel}・${formatSegmentTimestamp(segment.startMs)}`;
}

export function LiveCaptionWindow() {
  const [latestSegment, setLatestSegment] = useState<TranscriptSegment | null>(
    null,
  );
  const [latestBySource, setLatestBySource] = useState<LatestBySource>(
    createEmptyLatestBySource,
  );
  const [statusPayload, setStatusPayload] = useState<LiveCaptionStatusPayload>(
    () =>
      readStoredLiveCaptionStatus((e) => {
        console.error(
          "ライブ字幕ステータスの読み取りに失敗しました:",
          toErrorMessage(e),
        );
      }),
  );
  const [listenerError, setListenerError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const statusUnlistenPromise = listen<unknown>(
      LIVE_CAPTION_STATUS_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        if (isLiveCaptionStatusPayload(event.payload)) {
          setListenerError((current) =>
            current === INVALID_STATUS_PAYLOAD_ERROR ? null : current,
          );
          setStatusPayload(normalizeLiveCaptionStatusPayload(event.payload));
          return;
        }
        setListenerError(INVALID_STATUS_PAYLOAD_ERROR);
      },
    );
    const resetUnlistenPromise = listen("live-caption-reset", () => {
      if (disposed) {
        return;
      }
      setLatestSegment(null);
      setLatestBySource(createEmptyLatestBySource());
      setStatusPayload(
        readStoredLiveCaptionStatus((e) => {
          console.error(
            "ライブ字幕ステータスの読み取りに失敗しました:",
            toErrorMessage(e),
          );
        }),
      );
      setListenerError(null);
    });
    const resultUnlistenPromise = listen<unknown>(
      "transcription-result",
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptSegmentPayload(payload)) {
          setListenerError("ライブ字幕の文字起こし結果の形式が不正です。");
          return;
        }
        setListenerError(null);
        setLatestSegment(payload);
        if (payload.source) {
          setLatestBySource((prev) => ({
            ...prev,
            [payload.source as AudioSource]: payload,
          }));
        }
      },
    );
    const errorUnlistenPromise = listen<unknown>(
      "transcription-error",
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptionErrorPayload(payload)) {
          setListenerError("ライブ字幕の文字起こしエラー通知の形式が不正です。");
          return;
        }
        setListenerError(null);
        const errorSegment: TranscriptSegment = {
          text: `エラー: ${payload.error}`,
          startMs: 0,
          endMs: 0,
          source: payload.source,
          isError: true,
        };
        setLatestSegment(errorSegment);
        if (payload.source) {
          setLatestBySource((prev) => ({
            ...prev,
            [payload.source as AudioSource]: errorSegment,
          }));
        } else {
          setLatestBySource(createEmptyLatestBySource());
        }
      },
    );

    Promise.all([
      statusUnlistenPromise,
      resetUnlistenPromise,
      resultUnlistenPromise,
      errorUnlistenPromise,
    ])
      .then(() => {
        if (!disposed) {
          setListenerError(null);
        }
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("ライブ字幕の受信開始に失敗しました:", msg);
          setListenerError(`ライブ字幕の受信開始に失敗しました: ${msg}`);
        }
      });

    return () => {
      disposed = true;
      resetUnlistenPromise
        .then((unlisten) => unlisten())
        .catch((e) =>
          console.error("ライブ字幕リセットの受信解除に失敗しました:", toErrorMessage(e)),
        );
      resultUnlistenPromise
        .then((unlisten) => unlisten())
        .catch((e) =>
          console.error("ライブ字幕結果の受信解除に失敗しました:", toErrorMessage(e)),
        );
      errorUnlistenPromise
        .then((unlisten) => unlisten())
        .catch((e) =>
          console.error("ライブ字幕エラーの受信解除に失敗しました:", toErrorMessage(e)),
        );
      statusUnlistenPromise
        .then((unlisten) => unlisten())
        .catch((e) =>
          console.error(
            "ライブ字幕ステータスの受信解除に失敗しました:",
            toErrorMessage(e),
          ),
        );
    };
  }, []);

  const isErrorState = Boolean(
    listenerError || isTranscriptErrorSegment(latestSegment),
  );
  const captionTimestamp =
    latestSegment && !isTranscriptErrorSegment(latestSegment)
      ? formatSegmentTimestamp(latestSegment.startMs)
      : null;
  const trackStatusLabels = TRACKS.map((track) => {
    const captureLabel =
      track.source === "microphone"
        ? statusPayload.microphoneTrackLabel
        : statusPayload.systemAudioTrackLabel;
    const state = getTrackStateLabel(
      latestBySource[track.source],
      captureLabel,
    );
    return {
      ...track,
      state,
      ariaLabel: `${track.label}トラック: ${state}`,
    };
  });
  const trackRowLabel = [
    "音声トラック別の最新文字起こし状態",
    ...trackStatusLabels.map((track) => track.ariaLabel),
  ].join("、");
  const label = listenerError
    ? listenerError
    : latestSegment
      ? [
          "ライブ文字起こし",
          getSpeakerLabel(latestSegment),
          captionTimestamp ? `発話時刻 ${captionTimestamp}` : null,
          ...trackStatusLabels.map(
            (track) => `${track.label}トラック ${track.state}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          `外部送信 ${statusPayload.aiTransmissionLabel}`,
          latestSegment.text,
        ]
          .filter(Boolean)
          .join(": ")
      : [
          "ライブ文字起こし 待機中",
          ...trackStatusLabels.map(
            (track) => `${track.label}トラック ${track.state}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          `外部送信 ${statusPayload.aiTransmissionLabel}`,
          WAITING_CAPTION_TEXT,
        ].join(": ");
  const panelClassName = isErrorState
    ? "live-transcript-panel live-transcript-panel-window live-transcript-panel-error"
    : "live-transcript-panel live-transcript-panel-window";
  const liveCaptionRole = isErrorState ? "alert" : "status";
  const visibleTransmissionLabel = getVisibleTransmissionLabel(statusPayload);
  const liveCaptionTransmissionLabel = statusPayload.isExternalTransmission
    ? "外部送信中"
    : visibleTransmissionLabel;
  const liveCaptionTransmissionAriaLabel = statusPayload.isExternalTransmission
    ? `外部送信中 ${statusPayload.aiTransmissionLabel}`
    : `外部送信 ${statusPayload.aiTransmissionLabel}`;
  const hideLiveCaptionWindow = () => {
    void getCurrentWindow()
      .hide()
      .catch((e) => {
        console.error("ライブ字幕ウィンドウを隠せませんでした:", toErrorMessage(e));
      });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideLiveCaptionWindow();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div
      className="overlay-window live-caption-window"
      data-tauri-drag-region
      role={liveCaptionRole}
      aria-live={isErrorState ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={label}
      title={label}
    >
      <div className={panelClassName} data-tauri-drag-region>
        <div
          className="live-transcript-wave"
          data-tauri-drag-region
          aria-hidden="true"
        >
          <span />
          <span />
          <span />
        </div>
        <div className="live-transcript-content" data-tauri-drag-region>
          <div className="live-transcript-meta" data-tauri-drag-region>
            <span className="live-transcript-dot" aria-hidden="true" />
            <span data-tauri-drag-region>
              {isErrorState ? "文字起こしエラー" : "ライブ文字起こし"}
            </span>
            {latestSegment && (
              <span
                className={getSpeakerClassName(latestSegment)}
                data-tauri-drag-region
              >
                {getSpeakerLabel(latestSegment)}
              </span>
            )}
            {captionTimestamp && (
              <span
                className="live-transcript-timestamp"
                data-tauri-drag-region
                aria-label={`発話時刻 ${captionTimestamp}`}
                title={`発話時刻 ${captionTimestamp}`}
              >
                {captionTimestamp}
              </span>
            )}
            <span
              className={`live-transcript-engine-pill${
                statusPayload.isExternalTransmission
                  ? " live-transcript-engine-pill-warning"
                  : ""
              }`}
              data-tauri-drag-region
              aria-label={`文字起こしエンジン ${statusPayload.engineLabel}、外部送信 ${statusPayload.aiTransmissionLabel}`}
              title={`文字起こしエンジン ${statusPayload.engineLabel}、外部送信 ${statusPayload.aiTransmissionLabel}`}
            >
              {statusPayload.engineLabel}
            </span>
            <span
              className={`live-transcript-privacy-pill${
                statusPayload.isExternalTransmission
                  ? " live-transcript-privacy-pill-warning"
                  : ""
              }`}
              data-tauri-drag-region
              aria-label={liveCaptionTransmissionAriaLabel}
              title={liveCaptionTransmissionAriaLabel}
            >
              {liveCaptionTransmissionLabel}
            </span>
          </div>
          <div
            className="live-transcript-track-row"
            data-tauri-drag-region
            aria-label={trackRowLabel}
            title={trackRowLabel}
          >
            {trackStatusLabels.map((track) => {
              return (
                <span
                  key={track.source}
                  className={`live-transcript-track-pill live-transcript-track-pill-${track.source}`}
                  aria-label={track.ariaLabel}
                  title={track.ariaLabel}
                >
                  <span data-tauri-drag-region>{track.label}</span>
                  <span data-tauri-drag-region>{track.state}</span>
                </span>
              );
            })}
          </div>
          <div className="live-transcript-text" data-tauri-drag-region>
            {listenerError ?? latestSegment?.text ?? WAITING_CAPTION_TEXT}
          </div>
        </div>
        <button
          type="button"
          className="live-transcript-close-btn"
          aria-label="ライブ文字起こしウィンドウを閉じる"
          aria-keyshortcuts="Escape"
          title="ライブ文字起こしウィンドウを閉じる"
          onClick={hideLiveCaptionWindow}
        >
          ×
        </button>
      </div>
    </div>
  );
}
