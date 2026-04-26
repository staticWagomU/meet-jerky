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
  segmentsCount,
  onClearTranscript,
}: TranscriptionControlsProps) {
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

      <div className="controls-row">
        <button
          type="button"
          onClick={onToggleTranscription}
          disabled={
            isTranscriptionOperationPending ||
            (!canStartTranscription && !isTranscribing)
          }
          className={`control-btn ${isTranscribing ? "control-btn-transcribing" : "control-btn-transcribe"}`}
          aria-label={
            isTranscriptionOperationPending
              ? "文字起こしを処理中"
              : isTranscribing
                ? "文字起こしを停止"
                : "文字起こしを開始"
          }
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
            aria-label={`文字起こし ${segmentsCount} 件をクリア`}
          >
            クリア
          </button>
        )}
      </div>

      {sourceStatusText && (
        <div className="transcription-source-status" role="status">
          {sourceStatusText}
        </div>
      )}
      {startBlockedReason && (
        <div
          id={TRANSCRIPTION_START_BLOCKED_REASON_ID}
          className="transcription-source-status transcription-source-status-warning"
          role="status"
        >
          {startBlockedReason}
        </div>
      )}
    </>
  );
}
