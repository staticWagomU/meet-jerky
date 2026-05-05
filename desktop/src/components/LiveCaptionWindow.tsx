import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Minus } from "lucide-react";
import type { TranscriptSegment } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getTransmissionStatusAriaLabel,
  getVisibleTransmissionLabel,
  isLiveCaptionStatusPayload,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import {
  createEmptyLatestBySource,
  getSpeakerClassName,
  getSpeakerLabel,
  getTrackCaptureState,
  getTrackStateLabel,
  getVisibleTrackSummary,
  type LatestBySource,
} from "../utils/liveCaptionTrackHelpers";
import { formatSegmentTimestamp } from "../utils/timeFormat";
import {
  isTranscriptErrorSegment,
  isTranscriptSegmentPayload,
  isTranscriptionErrorPayload,
} from "../utils/transcriptSegment";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";

const WAITING_CAPTION_TEXT =
  "自分/相手側トラックの発話が確定するとここに表示されます。";
const WAITING_CAPTION_ARIA_TEXT =
  `${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}の発話が確定するとここに表示されます。`;
const INVALID_STATUS_PAYLOAD_ERROR =
  "ライブ字幕の状態通知の形式が不正です。";
const LIVE_CAPTION_CLOSE_LABEL =
  "ライブ文字起こしウィンドウを閉じる。Escape キーでも閉じられます。録音と文字起こしは継続します";
const LIVE_CAPTION_WINDOW_OPERATION_LABEL =
  "このウィンドウはドラッグで移動できます。閉じても録音と文字起こしは継続します";

async function hideLiveCaptionOverlayWindow(): Promise<void> {
  await invoke("set_live_caption_window_visible", { visible: false });
}

type AudioSource = NonNullable<TranscriptSegment["source"]>;
type TrackMeta = {
  source: AudioSource;
  label: string;
  ariaPrefix: string;
};

const TRACKS: Array<TrackMeta> = [
  { source: "microphone", label: "自分", ariaPrefix: SELF_TRACK_DEVICE_LABEL },
  {
    source: "system_audio",
    label: "相手側",
    ariaPrefix: OTHER_TRACK_DEVICE_LABEL,
  },
];

export function LiveCaptionWindow() {
  const [latestSegment, setLatestSegment] = useState<TranscriptSegment | null>(
    null,
  );
  const [recentSegments, setRecentSegments] = useState<TranscriptSegment[]>([]);
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

  const resetLiveCaptionState = useCallback(() => {
    setLatestSegment(null);
    setRecentSegments([]);
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
  }, []);

  useEffect(() => {
    resetLiveCaptionState();
  }, [resetLiveCaptionState]);

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
      resetLiveCaptionState();
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
        setRecentSegments((prev) => [...prev, payload].slice(-2));
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
        setRecentSegments([errorSegment]);
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
  }, [resetLiveCaptionState]);

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
    const captureState = getTrackCaptureState(captureLabel);
    const state = getTrackStateLabel(
      latestBySource[track.source],
      captureLabel,
    );
    return {
      ...track,
      captureState,
      state,
      ariaLabel: `${track.ariaPrefix}: ${state}`,
    };
  });
  const visibleTrackSummary = getVisibleTrackSummary(statusPayload);
  const trackRowLabel = [
    "音声トラック別の最新文字起こし状態",
    `表示中の音声取得状態: ${visibleTrackSummary}`,
    ...trackStatusLabels.map((track) => track.ariaLabel),
  ].join("、");
  const transmissionStatusAriaLabel =
    getTransmissionStatusAriaLabel(statusPayload);
  const label = listenerError
    ? listenerError
    : latestSegment
      ? [
          "ライブ文字起こし",
          LIVE_CAPTION_WINDOW_OPERATION_LABEL,
          getSpeakerLabel(latestSegment),
          captionTimestamp ? `発話時刻 ${captionTimestamp}` : null,
          ...trackStatusLabels.map(
            (track) => `${track.ariaPrefix} ${track.state}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          transmissionStatusAriaLabel,
          latestSegment.text,
        ]
          .filter(Boolean)
          .join(": ")
      : [
          "ライブ文字起こし 待機中",
          LIVE_CAPTION_WINDOW_OPERATION_LABEL,
          ...trackStatusLabels.map(
            (track) => `${track.ariaPrefix} ${track.state}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          transmissionStatusAriaLabel,
          WAITING_CAPTION_ARIA_TEXT,
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
    : "外部送信なし、端末内で処理";
  const transcriptLines =
    recentSegments.length > 0
      ? recentSegments
      : latestSegment
        ? [latestSegment]
        : [];
  const isWaitingState = transcriptLines.length === 0 && !listenerError;
  const compactCaptionLabel = "録音中 · 字幕を表示中";
  const hideLiveCaptionWindow = () => {
    void hideLiveCaptionOverlayWindow()
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

  if (isWaitingState) {
    return (
      <div
        className="overlay-window live-caption-window live-caption-window-compact"
        data-tauri-drag-region
        role={liveCaptionRole}
        aria-live="polite"
        aria-atomic="true"
        aria-label={label}
        title={label}
      >
        <div
          className="live-caption-compact-pill"
          data-tauri-drag-region
          aria-label={`${compactCaptionLabel}。${trackRowLabel}`}
          title={`${compactCaptionLabel}。${trackRowLabel}`}
        >
          <span className="live-caption-compact-dot" aria-hidden="true" />
          <span className="live-caption-compact-text" data-tauri-drag-region>
            {compactCaptionLabel}
          </span>
        </div>
      </div>
    );
  }

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
        <div className="live-transcript-status-row" data-tauri-drag-region>
          <span className="live-transcript-rec-pill" data-tauri-drag-region>
            <span aria-hidden="true" />
            録音中
          </span>
          <strong className="live-transcript-meeting-title" data-tauri-drag-region>
            ライブ文字起こし {captionTimestamp ?? "待機中"}
          </strong>
          <span
            className="live-transcript-health-pill"
            data-tauri-drag-region
            aria-label={trackRowLabel}
            title={trackRowLabel}
          >
            {visibleTrackSummary}
          </span>
          <span className="live-transcript-status-spacer" data-tauri-drag-region />
          <button
            type="button"
            className="live-transcript-minimize-btn"
            aria-label={LIVE_CAPTION_CLOSE_LABEL}
            aria-keyshortcuts="Escape"
            title={LIVE_CAPTION_CLOSE_LABEL}
            onClick={hideLiveCaptionWindow}
          >
            <Minus aria-hidden="true" size={18} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="live-transcript-end-preview-btn"
            aria-label={`${LIVE_CAPTION_CLOSE_LABEL}。録音停止ではありません`}
            title={`${LIVE_CAPTION_CLOSE_LABEL}。録音停止ではありません。`}
            onClick={hideLiveCaptionWindow}
          >
            閉じる
          </button>
        </div>

        <div className="live-transcript-content" data-tauri-drag-region>
          <div className="live-transcript-stream" data-tauri-drag-region>
            <div className="live-transcript-tabs" data-tauri-drag-region>
              <span className="live-transcript-tab live-transcript-tab-active">
                統合
              </span>
              <span className="live-transcript-tab">自分</span>
              <span className="live-transcript-tab">相手側</span>
              <span
                className={`live-transcript-engine-pill${
                  statusPayload.isExternalTransmission
                    ? " live-transcript-engine-pill-warning"
                    : ""
                }`}
                data-tauri-drag-region
                aria-label={`文字起こしエンジン ${statusPayload.engineLabel}、${transmissionStatusAriaLabel}`}
                title={`文字起こしエンジン ${statusPayload.engineLabel}、${transmissionStatusAriaLabel}`}
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

            <div className="live-transcript-lines" data-tauri-drag-region>
              {transcriptLines.length > 0 ? (
                transcriptLines.map((segment, index) => {
                  const timestamp = isTranscriptErrorSegment(segment)
                    ? "!"
                    : formatSegmentTimestamp(segment.startMs);
                  return (
                    <div
                      className={`live-transcript-line ${
                        isTranscriptErrorSegment(segment)
                          ? "live-transcript-line-error"
                          : ""
                      }`}
                      key={`${segment.startMs}-${segment.endMs}-${index}`}
                      data-tauri-drag-region
                    >
                      <span
                        className="live-transcript-timestamp"
                        data-tauri-drag-region
                      >
                        {timestamp}
                      </span>
                      <span
                        className={getSpeakerClassName(segment)}
                        data-tauri-drag-region
                      >
                        {getSpeakerLabel(segment)}
                      </span>
                      <span className="live-transcript-text" data-tauri-drag-region>
                        {segment.text}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="live-transcript-line" data-tauri-drag-region>
                  <span className="live-transcript-timestamp" data-tauri-drag-region>
                    --
                  </span>
                  <span
                    className="live-transcript-speaker live-transcript-speaker-unknown"
                    data-tauri-drag-region
                  >
                    待機
                  </span>
                  <span className="live-transcript-text" data-tauri-drag-region>
                    {listenerError ?? WAITING_CAPTION_TEXT}
                  </span>
                </div>
              )}
            </div>
          </div>

          <aside
            className="live-transcript-tools"
            data-tauri-drag-region
            aria-label={trackRowLabel}
            title={trackRowLabel}
          >
            <strong data-tauri-drag-region>音声入力</strong>
            {trackStatusLabels.map((track) => (
              <div
                key={track.source}
                className={`live-transcript-meter live-transcript-meter-${track.captureState}`}
                data-tauri-drag-region
                aria-label={track.ariaLabel}
                title={track.ariaLabel}
              >
                <span data-tauri-drag-region>
                  {track.source === "microphone" ? "マイク · 自分" : "システム · 相手側"}
                </span>
                <span className="live-transcript-meter-bar" aria-hidden="true">
                  <span />
                </span>
              </div>
            ))}
          </aside>
        </div>

      </div>
    </div>
  );
}
