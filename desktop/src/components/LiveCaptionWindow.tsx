import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import { formatSegmentTimestamp } from "../utils/timeFormat";

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

export function LiveCaptionWindow() {
  const [latestSegment, setLatestSegment] = useState<TranscriptSegment | null>(
    null,
  );
  const [listenerError, setListenerError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const resetUnlistenPromise = listen("live-caption-reset", () => {
      if (disposed) {
        return;
      }
      setLatestSegment(null);
      setListenerError(null);
    });
    const resultUnlistenPromise = listen<TranscriptSegment>(
      "transcription-result",
      (event) => {
        if (disposed || event.payload.isError) {
          return;
        }
        setLatestSegment(event.payload);
      },
    );
    const errorUnlistenPromise = listen<TranscriptionErrorPayload>(
      "transcription-error",
      (event) => {
        if (disposed) {
          return;
        }
        setLatestSegment({
          text: `エラー: ${event.payload.error}`,
          startMs: 0,
          endMs: 0,
          source: event.payload.source,
          isError: true,
        });
      },
    );

    Promise.all([
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
    };
  }, []);

  const isErrorState = Boolean(listenerError || latestSegment?.isError);
  const captionTimestamp =
    latestSegment && !latestSegment.isError
      ? formatSegmentTimestamp(latestSegment.startMs)
      : null;
  const label = listenerError
    ? listenerError
    : latestSegment
      ? [
          "ライブ文字起こし",
          getSpeakerLabel(latestSegment),
          captionTimestamp ? `発話時刻 ${captionTimestamp}` : null,
          latestSegment.text,
        ]
          .filter(Boolean)
          .join(": ")
      : "ライブ文字起こし 待機中";
  const panelClassName = isErrorState
    ? "live-transcript-panel live-transcript-panel-window live-transcript-panel-error"
    : "live-transcript-panel live-transcript-panel-window";

  return (
    <div
      className="overlay-window live-caption-window"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={label}
      title={label}
    >
      <div className={panelClassName}>
        <div className="live-transcript-wave" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="live-transcript-content">
          <div className="live-transcript-meta">
            <span className="live-transcript-dot" aria-hidden="true" />
            <span>{isErrorState ? "文字起こしエラー" : "ライブ文字起こし"}</span>
            {latestSegment && (
              <span className={getSpeakerClassName(latestSegment)}>
                {getSpeakerLabel(latestSegment)}
              </span>
            )}
            {captionTimestamp && (
              <span
                className="live-transcript-timestamp"
                aria-label={`発話時刻 ${captionTimestamp}`}
                title={`発話時刻 ${captionTimestamp}`}
              >
                {captionTimestamp}
              </span>
            )}
          </div>
          <div className="live-transcript-text">
            {listenerError ??
              latestSegment?.text ??
              "音声を聞き取り中です。発話が確定するとここに表示されます。"}
          </div>
        </div>
      </div>
    </div>
  );
}
