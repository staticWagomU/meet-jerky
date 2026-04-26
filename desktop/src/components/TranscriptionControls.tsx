import { ModelSelector } from "./ModelSelector";

interface TranscriptionControlsProps {
  isTranscribing: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
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
      <div className="controls-row">
        <ModelSelector
          selectedModel={selectedModel}
          onSelectModel={onModelChange}
          disabled={isTranscribing}
        />
      </div>

      <div className="controls-row">
        <button
          type="button"
          onClick={onToggleTranscription}
          disabled={
            isTranscriptionOperationPending ||
            (!canStartTranscription && !isTranscribing)
          }
          className={`control-btn ${isTranscribing ? "control-btn-transcribing" : "control-btn-transcribe"}`}
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
        <div className="transcription-source-status" role="status">
          {startBlockedReason}
        </div>
      )}
    </>
  );
}
