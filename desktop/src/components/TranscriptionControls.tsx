import { ModelSelector } from "./ModelSelector";

const TRANSCRIPTION_START_BLOCKED_REASON_ID =
  "transcription-start-blocked-reason";

interface TranscriptionControlsProps {
  isTranscribing: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  showModelSelector: boolean;
  onToggleTranscription: () => void;
  canStartTranscription: boolean;
  isTranscriptionOperationPending: boolean;
  startBlockedReason: string | null;
  sourceStatusText: string | null;
  sourceStatusIsWarning: boolean;
  segmentsCount: number;
  onClearTranscript: () => void;
}

export function TranscriptionControls({
  isTranscribing,
  selectedModel,
  onModelChange,
  showModelSelector,
  onToggleTranscription,
  canStartTranscription,
  isTranscriptionOperationPending,
  startBlockedReason,
  sourceStatusText,
  sourceStatusIsWarning,
  segmentsCount,
  onClearTranscript,
}: TranscriptionControlsProps) {
  const sourceStatusClassName =
    sourceStatusText && sourceStatusIsWarning
      ? "transcription-source-status transcription-source-status-warning"
      : "transcription-source-status";
  const transcriptionButtonLabel = isTranscriptionOperationPending
    ? "文字起こしを処理中"
    : isTranscribing
      ? "文字起こしを停止"
      : "文字起こしを開始";
  const clearTranscriptLabel = `文字起こし ${segmentsCount} 件をクリア`;
  const transcriptionControlsLabel = [
    "文字起こし操作",
    isTranscriptionOperationPending ? "処理中" : null,
    isTranscribing ? "文字起こし中" : "停止中",
    sourceStatusText,
    startBlockedReason ? `開始不可: ${startBlockedReason}` : null,
    `ログ ${segmentsCount} 件`,
  ]
    .filter(Boolean)
    .join("、");

  return (
    <>
      {showModelSelector && (
        <div className="controls-row">
          <ModelSelector
            selectedModel={selectedModel}
            onSelectModel={onModelChange}
            disabled={isTranscribing}
          />
        </div>
      )}

      <div
        className="controls-row"
        role="group"
        aria-busy={isTranscriptionOperationPending}
        aria-label={transcriptionControlsLabel}
        title={transcriptionControlsLabel}
      >
        <button
          type="button"
          onClick={onToggleTranscription}
          disabled={
            isTranscriptionOperationPending ||
            (!canStartTranscription && !isTranscribing)
          }
          className={`control-btn ${isTranscribing ? "control-btn-transcribing" : "control-btn-transcribe"}`}
          aria-label={transcriptionButtonLabel}
          title={transcriptionButtonLabel}
          aria-describedby={
            startBlockedReason ? TRANSCRIPTION_START_BLOCKED_REASON_ID : undefined
          }
        >
          {isTranscriptionOperationPending
            ? "処理中..."
            : isTranscribing
              ? "文字起こし停止"
              : "文字起こし開始"}
        </button>

        {segmentsCount > 0 && (
          <button
            type="button"
            onClick={onClearTranscript}
            className="control-btn control-btn-clear"
            aria-label={clearTranscriptLabel}
            title={clearTranscriptLabel}
          >
            クリア
          </button>
        )}
      </div>

      {sourceStatusText && (
        <div
          className={sourceStatusClassName}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`文字起こし音声ソース状態: ${sourceStatusText}`}
          title={`文字起こし音声ソース状態: ${sourceStatusText}`}
        >
          {sourceStatusText}
        </div>
      )}
      {startBlockedReason && (
        <div
          id={TRANSCRIPTION_START_BLOCKED_REASON_ID}
          className="transcription-source-status transcription-source-status-warning"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`文字起こし開始不可理由: ${startBlockedReason}`}
          title={`文字起こし開始不可理由: ${startBlockedReason}`}
        >
          {startBlockedReason}
        </div>
      )}
    </>
  );
}
