import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { Pause, Play } from "lucide-react";
import type { TranscriptSegment } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
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

function getSpeakerAriaLabel(segment: TranscriptSegment): string {
  if (segment.source === "microphone") return SELF_TRACK_DEVICE_LABEL;
  if (segment.source === "system_audio") {
    return OTHER_TRACK_DEVICE_LABEL;
  }
  if (segment.speaker === "自分") return "自分トラック";
  if (segment.speaker) return `話者 ${segment.speaker}`;
  return "音声ソース不明";
}

function isSourceLessError(segment: TranscriptSegment): boolean {
  return Boolean(
    isTranscriptErrorSegment(segment) && !segment.speaker && !segment.source,
  );
}

function getSegmentAriaLabel(segment: TranscriptSegment): string {
  const speakerLabel = isSourceLessError(segment)
    ? "音声ソース不明"
    : getSpeakerAriaLabel(segment);
  if (isTranscriptErrorSegment(segment)) {
    return `文字起こしエラー ${speakerLabel}: ${segment.text}`;
  }
  return `文字起こし ${formatSegmentTimestamp(segment.startMs)} ${speakerLabel}: ${segment.text}`;
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
      if (isTranscriptErrorSegment(segment)) {
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
  const isPaused = !autoScroll && segments.length > 0;

  // Listen to transcription-result events
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<unknown>(
      "transcription-result",
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptSegmentPayload(payload)) {
          setResultListenerError("文字起こし結果の形式が不正です。");
          return;
        }
        setResultListenerError(null);
        onNewSegment(payload);
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
    const unlistenPromise = listen<unknown>(
      "transcription-error",
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptionErrorPayload(payload)) {
          setErrorListenerError("文字起こしエラー通知の形式が不正です。");
          return;
        }
        setErrorListenerError(null);
        const errorSegment: TranscriptSegment = {
          text: `エラー: ${payload.error}`,
          startMs: 0,
          endMs: 0,
          source: payload.source,
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
      .filter((seg) => !isTranscriptErrorSegment(seg))
      .map((seg) => {
        const time = `[${formatSegmentTimestamp(seg.startMs)}]`;
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
      : `文字起こしログは空です。文字起こしを開始すると、${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}の発話がここに流れます`;
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
      ? "コピーできる表示中の文字起こし本文はありません"
      : isCopying
        ? `表示中の文字起こし本文 ${copyableSegmentsCount} 件をクリップボードへコピー中`
        : copyFeedback
          ? `表示中の文字起こし本文 ${copyableSegmentsCount} 件をクリップボードへコピー済み`
          : `表示中の文字起こし本文 ${copyableSegmentsCount} 件をクリップボードへコピー。録音、文字起こし、保存済み履歴には影響しません`;
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
              aria-label={`${SELF_TRACK_DEVICE_LABEL}の文字起こし: ${segmentCounts.self} 件`}
              title={`${SELF_TRACK_DEVICE_LABEL}の文字起こし: ${segmentCounts.self} 件`}
            >
              自分 {segmentCounts.self}
            </span>
            <span
              className="transcript-count-pill transcript-count-pill-other"
              aria-label={`${OTHER_TRACK_DEVICE_LABEL}の文字起こし: ${segmentCounts.other} 件`}
              title={`${OTHER_TRACK_DEVICE_LABEL}の文字起こし: ${segmentCounts.other} 件`}
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
          <div className="transcript-toolbar-actions">
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
            {isPaused && (
              <div
                className="transcript-pause-pill"
                aria-label="最新追従は一時停止中"
                title="最新追従は一時停止中"
              >
                <Pause aria-hidden="true" size={11} strokeWidth={2.4} />
                <span className="transcript-pause-pill-label">一時停止中</span>
                <span
                  className="transcript-pause-pill-separator"
                  aria-hidden="true"
                >
                  ·
                </span>
                <span className="transcript-pause-pill-track">自動追従</span>
                <button
                  type="button"
                  className="transcript-pause-pill-resume"
                  aria-label="文字起こしログの最新追従を再開"
                  title="文字起こしログの最新追従を再開"
                  onClick={handleScrollToLatest}
                >
                  <Play aria-hidden="true" size={9} strokeWidth={2.5} />
                  <span>再開</span>
                </button>
              </div>
            )}
          </div>
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
            文字起こしを開始すると、自分/相手側トラックの発話がここに流れます
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
            const isErrorSegment = isTranscriptErrorSegment(seg);
            const errorClass = isErrorSegment
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
                {!isErrorSegment && (
                  <span className="transcript-timestamp">
                    [{formatSegmentTimestamp(seg.startMs)}]
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
    </div>
  );
}
