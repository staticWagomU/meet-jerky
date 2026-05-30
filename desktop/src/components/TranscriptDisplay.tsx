import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { Pause, Play } from "lucide-react";
import type { TranscriptSegment } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import { formatSegmentTimestamp } from "../utils/timeFormat";
import {
  getTranscriptSegmentPayloadIssue,
  getTranscriptionErrorPayloadIssue,
  isTranscriptErrorSegment,
  isTranscriptSegmentPayload,
  isTranscriptionErrorPayload,
} from "../utils/transcriptSegment";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";
import {
  getSegmentAriaLabel,
  getSegmentCounts,
  getSpeakerKind,
  getSpeakerLabel,
  getVisibleSpeakerLabel,
} from "../utils/transcriptDisplayHelpers";
import {
  TRANSCRIPTION_ERROR_EVENT,
  TRANSCRIPTION_RESULT_EVENT,
} from "../utils/transcriptionEvents";
import { writeClipboardText } from "../utils/clipboard";

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
  const [copyFeedbackScope, setCopyFeedbackScope] = useState<
    "all" | "self" | "other" | null
  >(null);
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
      TRANSCRIPTION_RESULT_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptSegmentPayload(payload)) {
          const issue = getTranscriptSegmentPayloadIssue(payload);
          console.error("文字起こし結果の形式が不正です:", issue);
          setResultListenerError("文字起こし結果を表示できませんでした");
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
          setResultListenerError("文字起こし結果を表示できませんでした");
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "文字起こし結果の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, [onNewSegment]);

  // Listen to transcription-error events
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<unknown>(
      TRANSCRIPTION_ERROR_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptionErrorPayload(payload)) {
          const issue = getTranscriptionErrorPayloadIssue(payload);
          console.error("文字起こしエラー通知の形式が不正です:", issue);
          setErrorListenerError("文字起こしエラーを確認できませんでした");
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
          setErrorListenerError("文字起こしエラーを確認できませんでした");
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

  const clearCopyFeedback = useCallback(() => {
    setCopyFeedback(false);
    setCopyFeedbackScope(null);
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
      copyFeedbackTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (previousSegmentsRef.current === segments) {
      return;
    }
    previousSegmentsRef.current = segments;
    if (copyFeedback) {
      clearCopyFeedback();
    }
  }, [segments, copyFeedback, clearCopyFeedback]);

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

  const formatTranscriptSegments = useCallback(
    (targetSegments: TranscriptSegment[]) =>
      targetSegments
        .filter((seg) => !isTranscriptErrorSegment(seg))
        .map((seg) => {
          const time = `[${formatSegmentTimestamp(seg.startMs)}]`;
          const speakerLabel = getSpeakerLabel(seg);
          const speaker = speakerLabel ? `${speakerLabel}: ` : "";
          return `${time} ${speaker}${seg.text}`;
        })
        .join("\n"),
    [],
  );

  const copyTranscriptText = useCallback(
    async (text: string, scope: "all" | "self" | "other") => {
      try {
        setIsCopying(true);
        setCopyError(null);
        await writeClipboardText(text);
        if (!isMountedRef.current) {
          return;
        }
        setCopyError(null);
        setCopyFeedback(true);
        setCopyFeedbackScope(scope);
        if (copyFeedbackTimeoutRef.current) {
          clearTimeout(copyFeedbackTimeoutRef.current);
        }
        copyFeedbackTimeoutRef.current = setTimeout(() => {
          if (!isMountedRef.current) {
            return;
          }
          setCopyFeedback(false);
          setCopyFeedbackScope(null);
          copyFeedbackTimeoutRef.current = null;
        }, 2000);
      } catch (e) {
        console.error("文字起こしのコピーに失敗しました:", e);
        if (!isMountedRef.current) {
          return;
        }
        setCopyFeedback(false);
        setCopyFeedbackScope(null);
        setCopyError("文字起こしをコピーできませんでした");
      } finally {
        isCopyingRef.current = false;
        if (isMountedRef.current) {
          setIsCopying(false);
        }
      }
    },
    [],
  );

  const handleCopyAll = useCallback(async () => {
    if (isCopying || isCopyingRef.current) {
      return;
    }
    isCopyingRef.current = true;
    await copyTranscriptText(formatTranscriptSegments(segments), "all");
  }, [copyTranscriptText, formatTranscriptSegments, isCopying, segments]);

  const handleCopyTrack = useCallback(
    async (speakerKind: "self" | "other") => {
      if (isCopying || isCopyingRef.current) {
        return;
      }
      isCopyingRef.current = true;
      const trackSegments = segments.filter(
        (seg) =>
          !isTranscriptErrorSegment(seg) && getSpeakerKind(seg) === speakerKind,
      );
      await copyTranscriptText(
        formatTranscriptSegments(trackSegments),
        speakerKind,
      );
    },
    [copyTranscriptText, formatTranscriptSegments, isCopying, segments],
  );

  const transcriptLogLabel =
    segments.length > 0
      ? `文字起こし ${segments.length} 件。自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件。`
      : `文字起こしはまだありません。`;
  const transcriptCountsLabel = `文字起こし ${segments.length} 件。自分 ${segmentCounts.self}、相手側 ${segmentCounts.other}。`;
  const transcriptWrapperLabel = [
    transcriptCountsLabel,
    isCopying ? "コピー中" : null,
    !autoScroll && segments.length > 0 ? "最新追従を一時停止中" : null,
  ]
    .filter(Boolean)
    .join("、");
  const copyButtonLabel = isCopying
    ? `文字起こし ${copyableSegmentsCount} 件をコピー中`
    : copyFeedback && copyFeedbackScope === "all"
      ? `文字起こし ${copyableSegmentsCount} 件をコピー済み`
      : `文字起こし ${copyableSegmentsCount} 件をコピー`;
  const trackReviewItems = [
    {
      key: "self",
      label: "自分",
      value: `${segmentCounts.self}件`,
      detail: SELF_TRACK_DEVICE_LABEL,
      count: segmentCounts.self,
    },
    {
      key: "other",
      label: "相手側",
      value: `${segmentCounts.other}件`,
      detail: OTHER_TRACK_DEVICE_LABEL,
      count: segmentCounts.other,
    },
  ] as const;
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
              aria-label={`文字起こし ${segments.length} 件`}
              title={`文字起こし ${segments.length} 件`}
            >
              {segments.length} 件
            </span>
            <span
              className="transcript-count-pill transcript-count-pill-self"
              aria-label={`${SELF_TRACK_DEVICE_LABEL}: ${segmentCounts.self} 件`}
              title={`${SELF_TRACK_DEVICE_LABEL}: ${segmentCounts.self} 件`}
            >
              自分 {segmentCounts.self}
            </span>
            <span
              className="transcript-count-pill transcript-count-pill-other"
              aria-label={`${OTHER_TRACK_DEVICE_LABEL}: ${segmentCounts.other} 件`}
              title={`${OTHER_TRACK_DEVICE_LABEL}: ${segmentCounts.other} 件`}
            >
              相手側 {segmentCounts.other}
            </span>
            {segmentCounts.unknown > 0 && (
              <span
                className="transcript-count-pill transcript-count-pill-unknown"
                aria-label={`不明: ${segmentCounts.unknown} 件`}
                title={`不明: ${segmentCounts.unknown} 件`}
              >
                不明 {segmentCounts.unknown}
              </span>
            )}
            {segmentCounts.errors > 0 && (
              <span
                className="transcript-count-pill transcript-count-pill-error"
                aria-label={`エラー: ${segmentCounts.errors} 件`}
                title={`エラー: ${segmentCounts.errors} 件`}
              >
                エラー {segmentCounts.errors}
              </span>
            )}
          </div>
          <div className="transcript-toolbar-actions">
            {copyableSegmentsCount > 0 ? (
              <button
                type="button"
                className="copy-btn"
                aria-label={copyButtonLabel}
                aria-live="polite"
                aria-atomic="true"
                title={copyButtonLabel}
                onClick={handleCopyAll}
                disabled={isCopying}
              >
                {isCopying
                  ? "文字起こしコピー中…"
                  : copyFeedback && copyFeedbackScope === "all"
                    ? "文字起こしコピー済み"
                    : "文字起こしコピー"}
              </button>
            ) : null}
            {isPaused && (
              <div
                className="transcript-pause-pill"
                aria-label="録音中の文字起こし最新追従は一時停止中です。最新の発話へ戻れます。"
                title="録音中の文字起こし最新追従は一時停止中です。最新の発話へ戻れます。"
              >
                <Pause aria-hidden="true" size={11} strokeWidth={2.4} />
                <span className="transcript-pause-pill-label">一時停止中</span>
                <span
                  className="transcript-pause-pill-separator"
                  aria-hidden="true"
                >
                  ·
                </span>
                <span className="transcript-pause-pill-track">会議中</span>
                <button
                  type="button"
                  className="transcript-pause-pill-resume"
                  aria-label="最新の文字起こしへ戻る"
                  title="最新の文字起こしへ戻る"
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
      {segments.length > 0 && (
        <div
          className="transcript-track-rail"
          aria-label={`トラック別。自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件。音声トラックの外部送信なし。`}
          title={`トラック別: 自分 ${segmentCounts.self} 件、相手側 ${segmentCounts.other} 件、音声トラック外部送信なし`}
        >
          <div className="transcript-track-rail-grid">
            {trackReviewItems.map((item) => {
              const scope = item.key;
              const copied = copyFeedbackScope === scope;
              const copyTrackLabel = copied
                ? `${item.label} ${item.count} 件をコピー済み`
                : `${item.label} ${item.count} 件をコピー`;
              return (
                <span
                  key={item.key}
                  className={`transcript-track-rail-item transcript-track-rail-item-${item.key}`}
                >
                  <strong>{item.label}</strong>
                  <small>{item.value}</small>
                  <em>{item.detail}</em>
                  {item.count > 0 ? (
                    <button
                      type="button"
                      className="transcript-track-copy-btn"
                      onClick={() => handleCopyTrack(scope)}
                      disabled={isCopying}
                      aria-label={copyTrackLabel}
                      title={copyTrackLabel}
                    >
                      {copied ? "文字起こしコピー済み" : "文字起こしコピー"}
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {copyError && (
        <div
          className="transcript-inline-error transcript-inline-error-dismissible"
          role="alert"
          aria-label={`コピーエラー: ${copyError}`}
          title={`コピーエラー: ${copyError}`}
        >
          <span>{copyError}</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => setCopyError(null)}
            aria-label="コピーエラーを閉じる"
            title="コピーエラーを閉じる"
          >
            コピーエラーを閉じる
          </button>
        </div>
      )}
      {resultListenerError && (
        <div
          className="transcript-inline-error"
          role="alert"
          aria-label={`受信エラー: ${resultListenerError}`}
          title={`受信エラー: ${resultListenerError}`}
        >
          {resultListenerError}
        </div>
      )}
      {errorListenerError && (
        <div
          className="transcript-inline-error"
          role="alert"
          aria-label={`エラー通知: ${errorListenerError}`}
          title={`エラー通知: ${errorListenerError}`}
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
            文字起こしはここに表示されます
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
                  <span className="transcript-segment-meta">
                    <span className="transcript-timestamp">
                      [{formatSegmentTimestamp(seg.startMs)}]
                    </span>
                    {speakerLabel && (
                      <span
                        className={`transcript-speaker-label${speakerLabelClass}`}
                      >
                        {speakerLabel}
                      </span>
                    )}
                    <span className="transcript-segment-save-pill">
                      保存済み
                    </span>
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
