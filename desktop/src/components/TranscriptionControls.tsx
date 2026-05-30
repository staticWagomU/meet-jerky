import { ModelSelector } from "./ModelSelector";

const TRANSCRIPTION_START_BLOCKED_REASON_ID =
  "transcription-start-blocked-reason";

interface TranscriptionControlsProps {
  isTranscribing: boolean;
  hasTranscriptionErrorStopped: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  showModelSelector: boolean;
  onToggleTranscription: () => void;
  canStartTranscription: boolean;
  isTranscriptionOperationPending: boolean;
  startBlockedReason: string | null;
  sourceStatusText: string | null;
  sourceStatusAriaText: string | null;
  sourceStatusIsWarning: boolean;
  segmentsCount: number;
  onClearTranscript: () => void;
}

export function TranscriptionControls({
  isTranscribing,
  hasTranscriptionErrorStopped,
  selectedModel,
  onModelChange,
  showModelSelector,
  onToggleTranscription,
  canStartTranscription,
  isTranscriptionOperationPending,
  startBlockedReason,
  sourceStatusText,
  sourceStatusAriaText,
  sourceStatusIsWarning,
  segmentsCount,
  onClearTranscript,
}: TranscriptionControlsProps) {
  const sourceStatusClassName =
    sourceStatusText && sourceStatusIsWarning
      ? "transcription-source-status transcription-source-status-warning"
      : "transcription-source-status";
  const pendingTranscriptionLabel = isTranscribing
    ? "文字起こしを停止中"
    : "文字起こしを開始中";
  const isErrorStopped =
    !isTranscribing &&
    !isTranscriptionOperationPending &&
    hasTranscriptionErrorStopped;
  const stoppedTranscriptionStateLabel = isErrorStopped
    ? "エラー停止"
    : "停止中";
  const transcriptionButtonLabel = isTranscriptionOperationPending
    ? pendingTranscriptionLabel
    : isTranscribing
      ? "文字起こしを停止"
      : isErrorStopped
        ? "文字起こしを再開"
        : !canStartTranscription && startBlockedReason
          ? `開始不可: ${startBlockedReason}`
          : "文字起こしを開始";
  const clearTranscriptLabel = isTranscriptionOperationPending
    ? `${pendingTranscriptionLabel}のため操作できません`
    : `文字起こし ${segmentsCount} 件をクリア`;
  const transcriptionControlsLabel = [
    "録音中の表示",
    canStartTranscription || isTranscribing
      ? "音声入力OK"
      : "音声入力要確認",
    isTranscriptionOperationPending ? pendingTranscriptionLabel : null,
    isTranscribing ? "文字起こし中" : stoppedTranscriptionStateLabel,
    isTranscribing ? "翻訳はライブ画面で切替" : "翻訳は開始後",
    isTranscribing ? "ノートと質問準備を表示" : "ノートは開始後",
    "このMacに保存",
    "音声外部送信なし",
    sourceStatusAriaText ?? sourceStatusText,
    `ログ ${segmentsCount} 件`,
  ]
    .filter(Boolean)
    .join("、");
  const transcriptionStateItems = [
    {
      label: "REC",
      value: canStartTranscription || isTranscribing ? "録音可" : "録音前確認",
      detail: startBlockedReason ?? "自分+相手側",
      tone: canStartTranscription || isTranscribing ? "ready" : "warn",
    },
    {
      label: "文字起こし",
      value: isTranscriptionOperationPending
        ? "切替中"
        : isTranscribing
          ? "表示中"
          : stoppedTranscriptionStateLabel,
      detail: isTranscribing ? "リアルタイム" : "開始待ち",
      tone: isTranscribing ? "hot" : isErrorStopped ? "warn" : "muted",
    },
    {
      label: "ノート",
      value: isTranscribing ? "質問準備" : "開始後",
      detail: isTranscribing ? "ノート/質問準備" : "ノート待機",
      tone: isTranscribing ? "hot" : "muted",
    },
    {
      label: "翻訳",
      value: isTranscribing ? "切替可" : "開始後",
      detail: isTranscribing ? "ライブ画面" : "原文待機",
      tone: isTranscribing ? "hot" : "muted",
    },
    {
      label: "保存",
      value: "このMac",
      detail: "音声送信なし",
      tone: "safe",
    },
  ] as const;

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
        className="transcription-state-rail"
        aria-label={transcriptionControlsLabel}
        title={transcriptionControlsLabel}
      >
        {transcriptionStateItems.map((item) => (
          <span
            key={item.label}
            className={`transcription-state-item transcription-state-item-${item.tone}`}
          >
            <strong>{item.label}</strong>
            <small>{item.value}</small>
            <em>{item.detail}</em>
          </span>
        ))}
      </div>

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
            startBlockedReason
              ? TRANSCRIPTION_START_BLOCKED_REASON_ID
              : undefined
          }
        >
          {isTranscriptionOperationPending
            ? isTranscribing
              ? "文字起こし停止中…"
              : "文字起こし開始中…"
            : isTranscribing
              ? "文字起こし停止"
              : "文字起こし開始"}
        </button>

        {segmentsCount > 0 && (
          <button
            type="button"
            onClick={onClearTranscript}
            disabled={isTranscriptionOperationPending}
            className="control-btn control-btn-clear"
            aria-label={clearTranscriptLabel}
            title={clearTranscriptLabel}
          >
            文字起こしクリア
          </button>
        )}
      </div>

      {sourceStatusText && (
        <div
          className={sourceStatusClassName}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`音声ソース: ${sourceStatusAriaText ?? sourceStatusText}`}
          title={`音声ソース: ${sourceStatusAriaText ?? sourceStatusText}`}
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
          aria-label={`開始不可: ${startBlockedReason}`}
          title={`開始不可: ${startBlockedReason}`}
        >
          {startBlockedReason}
        </div>
      )}
    </>
  );
}
