import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TranscriptSegment, TranscriptionErrorPayload } from "../types";

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

  // Listen to transcription-result events
  useEffect(() => {
    const unlistenPromise = listen<TranscriptSegment>(
      "transcription-result",
      (event) => {
        onNewSegment(event.payload);
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [onNewSegment]);

  // Listen to transcription-error events
  useEffect(() => {
    const unlistenPromise = listen<TranscriptionErrorPayload>(
      "transcription-error",
      (event) => {
        const errorSegment: TranscriptSegment = {
          text: `エラー: ${event.payload.error}`,
          startMs: 0,
          endMs: 0,
          isError: true,
        };
        onNewSegment(errorSegment);
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [onNewSegment]);

  // Auto-scroll when new segments arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [segments, autoScroll]);

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

  return (
    <div className="transcript-display-wrapper">
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
            const speakerClass = seg.speaker
              ? seg.speaker === "自分"
                ? " transcript-speaker-self"
                : " transcript-speaker-other"
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
                {seg.speaker && (
                  <span
                    className={`transcript-speaker-label${
                      seg.speaker === "自分"
                        ? " speaker-label-self"
                        : " speaker-label-other"
                    }`}
                  >
                    {seg.speaker}:
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
