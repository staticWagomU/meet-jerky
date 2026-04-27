import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";

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
  if (segment.speaker) return segment.speaker;
  if (segment.source === "microphone") return "自分";
  if (segment.source === "system_audio") return "相手側";
  return "未分類";
}

function getSegmentCounts(segments: TranscriptSegment[]): {
  self: number;
  other: number;
  unknown: number;
  errors: number;
} {
  return segments.reduce(
    (counts, segment) => {
      if (segment.isError) {
        counts.errors += 1;
        return counts;
      }
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
    { self: 0, other: 0, unknown: 0, errors: 0 },
  );
}

function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

interface TranscriptDisplayProps {
  segments: TranscriptSegment[];
  onNewSegment: (segment: TranscriptSegment) => void;
}

export function TranscriptDisplay({
  segments,
  onNewSegment,
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
  const [copyError, setCopyError] = useState<string | null>(null);
  const [resultListenerError, setResultListenerError] = useState<string | null>(
    null,
  );
  const [errorListenerError, setErrorListenerError] = useState<string | null>(
    null,
  );
  const copyableSegmentsCount = segments.filter((seg) => !seg.isError).length;
  const segmentCounts = getSegmentCounts(segments);

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
      console.error("コピーに失敗しました:", e);
      if (!isMountedRef.current) {
        return;
      }
      setCopyFeedback(false);
      setCopyError(`コピーに失敗しました: ${String(e)}`);
    } finally {
      isCopyingRef.current = false;
      if (isMountedRef.current) {
        setIsCopying(false);
      }
    }
  }, [isCopying, segments]);

  const transcriptLogLabel =
    segments.length > 0
      ? `文字起こしログ ${segments.length} 件、自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件、未分類 ${segmentCounts.unknown} 件、エラー ${segmentCounts.errors} 件`
      : "文字起こしログは空です";

  return (
    <div className="transcript-display-wrapper">
      {segments.length > 0 && (
        <div className="transcript-toolbar">
          <div
            className="transcript-counts"
            aria-label={`文字起こし ${segments.length} 件、自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件、未分類 ${segmentCounts.unknown} 件、エラー ${segmentCounts.errors} 件`}
          >
            <span className="transcript-segment-count">
              {segments.length} 件
            </span>
            <span className="transcript-count-pill transcript-count-pill-self">
              自分 {segmentCounts.self}
            </span>
            <span className="transcript-count-pill transcript-count-pill-other">
              相手側 {segmentCounts.other}
            </span>
            {segmentCounts.unknown > 0 && (
              <span className="transcript-count-pill transcript-count-pill-unknown">
                未分類 {segmentCounts.unknown}
              </span>
            )}
            {segmentCounts.errors > 0 && (
              <span className="transcript-count-pill transcript-count-pill-error">
                エラー {segmentCounts.errors}
              </span>
            )}
          </div>
          <button
            type="button"
            className="copy-btn"
            aria-label={
              copyableSegmentsCount === 0
                ? "コピーできる文字起こしはありません"
                : isCopying
                ? `文字起こし ${copyableSegmentsCount} 件をコピー中`
                : copyFeedback
                  ? `文字起こし ${copyableSegmentsCount} 件をコピー済み`
                  : `文字起こし ${copyableSegmentsCount} 件をコピー`
            }
            onClick={handleCopyAll}
            disabled={copyableSegmentsCount === 0 || isCopying}
          >
            {isCopying ? "コピー中..." : copyFeedback ? "コピー済み" : "コピー"}
          </button>
        </div>
      )}
      {copyError && (
        <div
          className="transcript-copy-error"
          role="alert"
          aria-label={`文字起こしコピーエラー: ${copyError}`}
        >
          {copyError}
        </div>
      )}
      {resultListenerError && (
        <div
          className="transcript-copy-error"
          role="alert"
          aria-label={`文字起こし結果受信エラー: ${resultListenerError}`}
        >
          {resultListenerError}
        </div>
      )}
      {errorListenerError && (
        <div
          className="transcript-copy-error"
          role="alert"
          aria-label={`文字起こしエラー受信エラー: ${errorListenerError}`}
        >
          {errorListenerError}
        </div>
      )}
      <div
        ref={containerRef}
        className="transcript-display"
        role="log"
        aria-label={transcriptLogLabel}
        aria-relevant="additions text"
        onScroll={handleScroll}
      >
        {segments.length === 0 ? (
          <div className="transcript-empty">
            文字起こしを開始すると、自分 / 相手側トラックの発話がここに流れます
          </div>
        ) : (
          segments.map((seg, i) => {
            const speakerKind = getSpeakerKind(seg);
            const speakerLabel = seg.isError ? null : getSpeakerLabel(seg);
            const speakerClass =
              seg.isError
                ? ""
                : speakerKind === "self"
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
            return (
              <div
                key={i}
                className={`transcript-segment${errorClass}${speakerClass}`}
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
          aria-label="最新の文字起こしへスクロール"
          onClick={() => {
            setAutoScroll(true);
            userScrolledRef.current = false;
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight;
            }
          }}
        >
          最新へ
        </button>
      )}
    </div>
  );
}
