import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getVisibleTransmissionLabel,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import { formatSegmentTimestamp } from "../utils/timeFormat";
import { isTranscriptErrorSegment } from "../utils/transcriptSegment";

const WAITING_CAPTION_TEXT =
  "自分/相手側トラックの発話が確定するとここに表示されます。";

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
    const statusUnlistenPromise = listen<LiveCaptionStatusPayload>(
      LIVE_CAPTION_STATUS_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        setStatusPayload(event.payload);
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
    const resultUnlistenPromise = listen<TranscriptSegment>(
      "transcription-result",
      (event) => {
        if (disposed) {
          return;
        }
        setLatestSegment(event.payload);
        if (event.payload.source) {
          setLatestBySource((prev) => ({
            ...prev,
            [event.payload.source as AudioSource]: event.payload,
          }));
        }
      },
    );
    const errorUnlistenPromise = listen<TranscriptionErrorPayload>(
      "transcription-error",
      (event) => {
        if (disposed) {
          return;
        }
        const errorSegment: TranscriptSegment = {
          text: `エラー: ${event.payload.error}`,
          startMs: 0,
          endMs: 0,
          source: event.payload.source,
          isError: true,
        };
        setLatestSegment(errorSegment);
        if (event.payload.source) {
          setLatestBySource((prev) => ({
            ...prev,
            [event.payload.source as AudioSource]: errorSegment,
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
  const label = listenerError
    ? listenerError
    : latestSegment
      ? [
          "ライブ文字起こし",
          getSpeakerLabel(latestSegment),
          captionTimestamp ? `発話時刻 ${captionTimestamp}` : null,
          ...TRACKS.map(
            (track) =>
              `${track.label}トラック ${getTrackStateLabel(
                latestBySource[track.source],
                track.source === "microphone"
                  ? statusPayload.microphoneTrackLabel
                  : statusPayload.systemAudioTrackLabel,
              )}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          `外部送信 ${statusPayload.aiTransmissionLabel}`,
          latestSegment.text,
        ]
          .filter(Boolean)
          .join(": ")
      : [
          "ライブ文字起こし 待機中",
          ...TRACKS.map(
            (track) =>
              `${track.label}トラック ${getTrackStateLabel(
                latestBySource[track.source],
                track.source === "microphone"
                  ? statusPayload.microphoneTrackLabel
                  : statusPayload.systemAudioTrackLabel,
              )}`,
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

  return (
    <div
      className="overlay-window live-caption-window"
      role={liveCaptionRole}
      aria-live={isErrorState ? "assertive" : "polite"}
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
            <span
              className={`live-transcript-engine-pill${
                statusPayload.isExternalTransmission
                  ? " live-transcript-engine-pill-warning"
                  : ""
              }`}
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
              aria-label={`外部送信 ${statusPayload.aiTransmissionLabel}`}
              title={`外部送信 ${statusPayload.aiTransmissionLabel}`}
            >
              {visibleTransmissionLabel}
            </span>
          </div>
          <div
            className="live-transcript-track-row"
            aria-label="音声トラック別の最新文字起こし状態"
          >
            {TRACKS.map((track) => {
              const segment = latestBySource[track.source];
              const captureLabel =
                track.source === "microphone"
                  ? statusPayload.microphoneTrackLabel
                  : statusPayload.systemAudioTrackLabel;
              const trackState = getTrackStateLabel(segment, captureLabel);
              const trackLabel = `${track.label}トラック: ${trackState}`;
              return (
                <span
                  key={track.source}
                  className={`live-transcript-track-pill live-transcript-track-pill-${track.source}`}
                  aria-label={trackLabel}
                  title={trackLabel}
                >
                  <span>{track.label}</span>
                  <span>{trackState}</span>
                </span>
              );
            })}
          </div>
          <div className="live-transcript-text">
            {listenerError ?? latestSegment?.text ?? WAITING_CAPTION_TEXT}
          </div>
        </div>
      </div>
    </div>
  );
}
