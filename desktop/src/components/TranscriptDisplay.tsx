import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";
import { toErrorMessage } from "../utils/errorMessage";

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getSpeakerKind(
  segment: TranscriptSegment,
): "self" | "other" | null {
  if (segment.source === "microphone") return "self";
  if (segment.source === "system_audio") return "other";
  if (segment.speaker === "自分") return "self";
  if (segment.speaker) return "other";
  return null;
}

function getSpeakerLabel(segment: TranscriptSegment): string | null {
  if (segment.source === "microphone") return "自分";
  if (segment.source === "system_audio") return "相手側";
  if (segment.speaker) return segment.speaker;
  return "ソース不明";
}

function isSourceLessError(segment: TranscriptSegment): boolean {
  return Boolean(segment.isError && !segment.speaker && !segment.source);
}

function getSegmentAriaLabel(segment: TranscriptSegment): string {
  const speakerLabel =
    isSourceLessError(segment)
      ? "音声ソース不明"
      : getSpeakerLabel(segment) ?? "音声ソース不明";
  if (segment.isError) {
    return `文字起こしエラー ${speakerLabel}: ${segment.text}`;
  }
  return `文字起こし ${formatTimestamp(segment.startMs)} ${speakerLabel}: ${segment.text}`;
}

function getVisibleSpeakerLabel(segment: TranscriptSegment): string | null {
  if (isSourceLessError(segment)) {
    return "ソース不明";
  }
  return getSpeakerLabel(segment);
}

function getSegmentCounts(segments: TranscriptSegment[]): {
  self: number;
  other: number;
  unknown: number;
  errors: number;
  copyable: number;
} {
  return segments.reduce(
    (counts, segment) => {
      if (segment.isError) {
        counts.errors += 1;
        return counts;
      }
      counts.copyable += 1;
      const speakerKind = getSpeakerKind(segment);
      if (speakerKind === "self") {
        counts.self += 1;
      } else if (speakerKind === "other") {
        counts.other += 1;
      } else {
        counts.unknown += 1;
      }
      return counts;
    },
    { self: 0, other: 0, unknown: 0, errors: 0, copyable: 0 },
  );
}

interface TranscriptDisplayProps {
  segments: TranscriptSegment[];
  onNewSegment: (segment: TranscriptSegment) => void;
  isLive?: boolean;
}

export function TranscriptDisplay({
  segments,
  onNewSegment,
  isLive = false,
}: TranscriptDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);
  const [isCopying, setIsCopying] = useState(false);
  const isCopyingRef = useRef(false);
  const isMountedRef = useRef(true);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const previousSegmentsRef = useRef(segments);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [resultListenerError, setResultListenerError] = useState<string | null>(
    null,
  );
  const [errorListenerError, setErrorListenerError] = useState<string | null>(
    null,
  );
  const segmentCounts = useMemo(() => getSegmentCounts(segments), [segments]);
  const copyableSegmentsCount = segmentCounts.copyable;
  const latestVisibleSegment = useMemo(
    () => [...segments].reverse().find((segment) => !segment.isError) ?? null,
    [segments],
  );

  // Listen to transcription-result events
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<TranscriptSegment>(
      "transcription-result",
      (event) => {
        if (disposed) {
          return;
        }
        onNewSegment(event.payload);
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setResultListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("文字起こし結果の受信開始に失敗しました:", msg);
          setResultListenerError(
            `文字起こし結果の受信開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error("文字起こし結果の受信解除に失敗しました:", toErrorMessage(e));
        });
    };
  }, [onNewSegment]);

  // Listen to transcription-error events
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<TranscriptionErrorPayload>(
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
        onNewSegment(errorSegment);
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setErrorListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("文字起こしエラー通知の受信開始に失敗しました:", msg);
          setErrorListenerError(
            `文字起こしエラー通知の受信開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "文字起こしエラー通知の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, [onNewSegment]);

  // Auto-scroll when new segments arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [segments, autoScroll]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
        copyFeedbackTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (previousSegmentsRef.current === segments) {
      return;
    }
    previousSegmentsRef.current = segments;
    if (copyFeedback) {
      setCopyFeedback(false);
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
        copyFeedbackTimeoutRef.current = null;
      }
    }
  }, [segments, copyFeedback]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;

    if (isAtBottom) {
      userScrolledRef.current = false;
      setAutoScroll(true);
    } else {
      if (!userScrolledRef.current) {
        userScrolledRef.current = true;
        setAutoScroll(false);
      }
    }
  }, []);

  const handleScrollToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    userScrolledRef.current = false;
    setAutoScroll(true);
  }, []);

  const handleCopyAll = useCallback(async () => {
    if (isCopying || isCopyingRef.current) {
      return;
    }
    isCopyingRef.current = true;
    const text = segments
      .filter((seg) => !seg.isError)
      .map((seg) => {
        const time = `[${formatTimestamp(seg.startMs)}]`;
        const speakerLabel = getSpeakerLabel(seg);
        const speaker = speakerLabel ? `${speakerLabel}: ` : "";
        return `${time} ${speaker}${seg.text}`;
      })
      .join("\n");

    try {
      setIsCopying(true);
      setCopyError(null);
      await navigator.clipboard.writeText(text);
      if (!isMountedRef.current) {
        return;
      }
      setCopyError(null);
      setCopyFeedback(true);
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      copyFeedbackTimeoutRef.current = setTimeout(() => {
        if (!isMountedRef.current) {
          return;
        }
        setCopyFeedback(false);
        copyFeedbackTimeoutRef.current = null;
      }, 2000);
    } catch (e) {
      console.error("文字起こし本文のコピーに失敗しました:", e);
      if (!isMountedRef.current) {
        return;
      }
      setCopyFeedback(false);
      setCopyError(
        `文字起こし本文のコピーに失敗しました: ${toErrorMessage(e)}`,
      );
    } finally {
      isCopyingRef.current = false;
      if (isMountedRef.current) {
        setIsCopying(false);
      }
    }
  }, [isCopying, segments]);

  const transcriptLogLabel =
    segments.length > 0
      ? `文字起こしログ ${segments.length} 件、自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件、ソース不明 ${segmentCounts.unknown} 件、エラー ${segmentCounts.errors} 件`
      : "文字起こしログは空です。文字起こしを開始すると、自分と相手側トラックの発話がここに流れます";
  const transcriptCountsLabel = `文字起こし ${segments.length} 件、自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件、ソース不明 ${segmentCounts.unknown} 件、エラー ${segmentCounts.errors} 件`;
  const transcriptWrapperLabel = [
    transcriptCountsLabel,
    isCopying ? "コピー中" : null,
    !autoScroll && segments.length > 0 ? "最新追従を一時停止中" : null,
  ]
    .filter(Boolean)
    .join("、");
  const copyButtonLabel =
    copyableSegmentsCount === 0
      ? "コピーできる文字起こしはありません"
      : isCopying
        ? `文字起こし本文 ${copyableSegmentsCount} 件をコピー中`
        : copyFeedback
          ? `文字起こし本文 ${copyableSegmentsCount} 件をコピー済み`
          : `文字起こし本文 ${copyableSegmentsCount} 件をコピー`;
  const liveTranscriptLabel = latestVisibleSegment
    ? `ライブ文字起こし ${getSpeakerLabel(latestVisibleSegment)}: ${latestVisibleSegment.text}`
    : "ライブ文字起こし 待機中";

  return (
    <div
      className="transcript-display-wrapper"
      aria-busy={isCopying}
      aria-label={transcriptWrapperLabel}
      title={transcriptWrapperLabel}
    >
      {segments.length > 0 && (
        <div className="transcript-toolbar">
          <div
            className="transcript-counts"
            aria-label={transcriptCountsLabel}
            title={transcriptCountsLabel}
          >
            <span
              className="transcript-segment-count"
              aria-label={`文字起こし総件数: ${segments.length} 件`}
              title={`文字起こし総件数: ${segments.length} 件`}
            >
              {segments.length} 件
            </span>
            <span
              className="transcript-count-pill transcript-count-pill-self"
              aria-label={`自分トラックの文字起こし: ${segmentCounts.self} 件`}
              title={`自分トラックの文字起こし: ${segmentCounts.self} 件`}
            >
              自分 {segmentCounts.self}
            </span>
            <span
              className="transcript-count-pill transcript-count-pill-other"
              aria-label={`相手側トラックの文字起こし: ${segmentCounts.other} 件`}
              title={`相手側トラックの文字起こし: ${segmentCounts.other} 件`}
            >
              相手側 {segmentCounts.other}
            </span>
            {segmentCounts.unknown > 0 && (
              <span
                className="transcript-count-pill transcript-count-pill-unknown"
                aria-label={`音声ソース不明の文字起こし: ${segmentCounts.unknown} 件`}
                title={`音声ソース不明の文字起こし: ${segmentCounts.unknown} 件`}
              >
                ソース不明 {segmentCounts.unknown}
              </span>
            )}
            {segmentCounts.errors > 0 && (
              <span
                className="transcript-count-pill transcript-count-pill-error"
                aria-label={`文字起こしエラー: ${segmentCounts.errors} 件`}
                title={`文字起こしエラー: ${segmentCounts.errors} 件`}
              >
                エラー {segmentCounts.errors}
              </span>
            )}
          </div>
          <button
            type="button"
            className="copy-btn"
            aria-label={copyButtonLabel}
            aria-live="polite"
            aria-atomic="true"
            title={copyButtonLabel}
            onClick={handleCopyAll}
            disabled={copyableSegmentsCount === 0 || isCopying}
          >
            {isCopying
              ? "コピー中..."
              : copyFeedback
                ? "コピー済み"
                : "本文をコピー"}
          </button>
        </div>
      )}
      {copyError && (
        <div
          className="transcript-inline-error transcript-inline-error-dismissible"
          role="alert"
          aria-label={`文字起こし本文コピーエラー: ${copyError}`}
          title={`文字起こし本文コピーエラー: ${copyError}`}
        >
          <span>{copyError}</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => setCopyError(null)}
            aria-label="文字起こし本文コピーエラーを閉じる"
            title="文字起こし本文コピーエラーを閉じる"
          >
            閉じる
          </button>
        </div>
      )}
      {resultListenerError && (
        <div
          className="transcript-inline-error"
          role="alert"
          aria-label={`文字起こし結果受信エラー: ${resultListenerError}`}
          title={`文字起こし結果受信エラー: ${resultListenerError}`}
        >
          {resultListenerError}
        </div>
      )}
      {errorListenerError && (
        <div
          className="transcript-inline-error"
          role="alert"
          aria-label={`文字起こしエラー受信エラー: ${errorListenerError}`}
          title={`文字起こしエラー受信エラー: ${errorListenerError}`}
        >
          {errorListenerError}
        </div>
      )}
      <div
        ref={containerRef}
        className="transcript-display"
        role="log"
        aria-label={transcriptLogLabel}
        title={transcriptLogLabel}
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
        onScroll={handleScroll}
      >
        {segments.length === 0 ? (
          <div
            className="transcript-empty"
            aria-label={transcriptLogLabel}
            title={transcriptLogLabel}
          >
            文字起こしを開始すると、自分と相手側トラックの発話がここに流れます
          </div>
        ) : (
          segments.map((seg, i) => {
            const speakerKind = getSpeakerKind(seg);
            const speakerLabel = getVisibleSpeakerLabel(seg);
            const speakerClass =
              speakerKind === "self"
                ? " transcript-speaker-self"
                : speakerKind === "other"
                  ? " transcript-speaker-other"
                  : " transcript-speaker-unknown";
            const speakerLabelClass =
              speakerKind === "self"
                ? " speaker-label-self"
                : speakerKind === "other"
                  ? " speaker-label-other"
                  : " speaker-label-unknown";
            const errorClass = seg.isError
              ? " transcript-segment-error"
              : "";
            const segmentAriaLabel = getSegmentAriaLabel(seg);
            return (
              <div
                key={i}
                className={`transcript-segment${errorClass}${speakerClass}`}
                aria-label={segmentAriaLabel}
                title={segmentAriaLabel}
              >
                {!seg.isError && (
                  <span className="transcript-timestamp">
                    [{formatTimestamp(seg.startMs)}]
                  </span>
                )}
                {speakerLabel && (
                  <span
                    className={`transcript-speaker-label${speakerLabelClass}`}
                  >
                    {speakerLabel}:
                  </span>
                )}
                <span className="transcript-text">{seg.text}</span>
              </div>
            );
          })
        )}
      </div>
      {!autoScroll && (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          aria-label="文字起こしログの最新位置へ戻る"
          title="文字起こしログの最新位置へ戻る"
          onClick={handleScrollToLatest}
        >
          最新へ戻る
        </button>
      )}
      {isLive && (
        <div
          className="live-transcript-panel"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={liveTranscriptLabel}
          title={liveTranscriptLabel}
        >
          <div className="live-transcript-wave" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="live-transcript-content">
            <div className="live-transcript-meta">
              <span className="live-transcript-dot" aria-hidden="true" />
              <span>ライブ文字起こし</span>
              {latestVisibleSegment && (
                <span className="live-transcript-speaker">
                  {getSpeakerLabel(latestVisibleSegment)}
                </span>
              )}
            </div>
            <div className="live-transcript-text">
              {latestVisibleSegment
                ? latestVisibleSegment.text
                : "音声を聞き取り中です。発話が確定するとここに表示されます。"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
