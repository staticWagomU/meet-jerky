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
  if (segment.source === "system_audio") return "相手";
  return null;
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
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
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
      await navigator.clipboard.writeText(text);
      setCopyError(null);
      setCopyFeedback(true);
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      copyFeedbackTimeoutRef.current = setTimeout(() => {
        setCopyFeedback(false);
        copyFeedbackTimeoutRef.current = null;
      }, 2000);
    } catch (e) {
      console.error("コピーに失敗しました:", e);
      setCopyFeedback(false);
      setCopyError(`コピーに失敗しました: ${String(e)}`);
    }
  }, [segments]);

  return (
    <div className="transcript-display-wrapper">
      {segments.length > 0 && (
        <div className="transcript-toolbar">
          <span className="transcript-segment-count">
            {segments.length} 件
          </span>
          <button
            type="button"
            className="copy-btn"
            onClick={handleCopyAll}
            disabled={copyableSegmentsCount === 0}
          >
            {copyFeedback ? "コピー済み" : "コピー"}
          </button>
        </div>
      )}
      {copyError && (
        <div className="transcript-copy-error" role="alert">
          {copyError}
        </div>
      )}
      {resultListenerError && (
        <div className="transcript-copy-error" role="alert">
          {resultListenerError}
        </div>
      )}
      {errorListenerError && (
        <div className="transcript-copy-error" role="alert">
          {errorListenerError}
        </div>
      )}
      <div
        ref={containerRef}
        className="transcript-display"
        onScroll={handleScroll}
      >
        {segments.length === 0 ? (
          <div className="transcript-empty">
            文字起こし結果がここに表示されます
          </div>
        ) : (
          segments.map((seg, i) => {
            const speakerKind = getSpeakerKind(seg);
            const speakerLabel = getSpeakerLabel(seg);
            const speakerClass =
              speakerKind === "self"
                ? " transcript-speaker-self"
                : speakerKind === "other"
                  ? " transcript-speaker-other"
                  : "";
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
                    className={`transcript-speaker-label${
                      speakerKind === "self"
                        ? " speaker-label-self"
                        : " speaker-label-other"
                    }`}
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
