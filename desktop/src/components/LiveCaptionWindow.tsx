import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import {
  Clipboard,
  Languages,
  MessageSquareText,
  Minus,
  SendHorizontal,
  Sparkles,
} from "lucide-react";
import type {
  AiMinutesProvider,
  AppSettings,
  TranscriptSegment,
} from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import {
  LIVE_CAPTION_STATUS_EVENT,
  getLiveCaptionStatusPayloadIssue,
  getTransmissionStatusAriaLabel,
  isLiveCaptionStatusPayload,
  markLiveCaptionStatusOnError,
  normalizeLiveCaptionStatusPayload,
  readStoredLiveCaptionStatus,
  recoverLiveCaptionStatusOnValidResult,
  type LiveCaptionStatusPayload,
} from "../utils/liveCaptionStatus";
import {
  TRACKS,
  createEmptyLatestBySource,
  getSpeakerClassName,
  getSpeakerLabel,
  getTrackCaptureState,
  getTrackStateLabel,
  getVisibleTrackSummary,
  type AudioSource,
  type LatestBySource,
} from "../utils/liveCaptionTrackHelpers";
import { formatSegmentTimestamp } from "../utils/timeFormat";
import {
  getTranscriptSegmentPayloadIssue,
  getTranscriptionErrorPayloadIssue,
  isTranscriptErrorSegment,
  isTranscriptSegmentPayload,
  isTranscriptionErrorPayload,
} from "../utils/transcriptSegment";
import {
  LIVE_CAPTION_RESET_EVENT,
  TRANSCRIPTION_ERROR_EVENT,
  TRANSCRIPTION_RESULT_EVENT,
} from "../utils/transcriptionEvents";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";
import { isTauriRuntime } from "../utils/browserRuntime";
import { writeClipboardText } from "../utils/clipboard";
import {
  PREVIEW_APP_SETTINGS,
  PREVIEW_LIVE_CAPTION_STATUS,
  PREVIEW_TRANSCRIPT_SEGMENTS,
} from "../utils/previewAppData";

const WAITING_CAPTION_TEXT = "発話が入るとここに表示されます。";
const WAITING_CAPTION_ARIA_TEXT = `${SELF_TRACK_DEVICE_LABEL}と${OTHER_TRACK_DEVICE_LABEL}の発話が確定するとここに表示されます。`;
const INVALID_STATUS_PAYLOAD_ERROR =
  "ライブ文字起こしの状態を確認できませんでした。";
const LIVE_CAPTION_CLOSE_LABEL = "ライブ文字起こしを閉じる";
const AI_QUESTION_SUGGESTIONS = [
  "決定事項は？",
  "次のタスク",
  "未解決の論点",
] as const;
type CaptionMode = "transcript" | "translation";
type TranslationTarget = "en" | "ja" | "ko" | "zh";
const TRANSLATION_ENGINE_LABEL = "翻訳エンジン未接続";
const LIVE_CAPTION_PREFERENCES_STORAGE_KEY =
  "meet-jerky:live-caption-preferences";
const LIVE_CAPTION_AI_QUESTION_STORAGE_KEY =
  "meet-jerky:live-caption-ai-question";
const EXTERNAL_AI_MINUTES_PROVIDERS = new Set<AiMinutesProvider>([
  "anthropic",
  "openAI",
]);

const TRANSLATION_TARGET_OPTIONS: ReadonlyArray<{
  value: TranslationTarget;
  shortLabel: string;
  label: string;
}> = [
  { value: "en", shortLabel: "EN", label: "英語" },
  { value: "ja", shortLabel: "JA", label: "日本語" },
  { value: "ko", shortLabel: "KO", label: "한국어" },
  { value: "zh", shortLabel: "ZH", label: "中文" },
];

interface LiveCaptionPreferences {
  captionMode: CaptionMode;
  aiNotesEnabled: boolean;
  translationTarget: TranslationTarget;
}

interface LiveCaptionAiQuestionState {
  draft: string;
  queuedQuestion: string | null;
}

const defaultLiveCaptionPreferences: LiveCaptionPreferences = {
  captionMode: "transcript",
  aiNotesEnabled: false,
  translationTarget: "en",
};

function isCaptionMode(value: unknown): value is CaptionMode {
  return value === "transcript" || value === "translation";
}

function isTranslationTarget(value: unknown): value is TranslationTarget {
  return value === "en" || value === "ja" || value === "ko" || value === "zh";
}

function getTranslationTargetOption(target: TranslationTarget) {
  return (
    TRANSLATION_TARGET_OPTIONS.find((option) => option.value === target) ??
    TRANSLATION_TARGET_OPTIONS[0]
  );
}

interface LocalMeetingNotes {
  summary: string[];
  decisions: string[];
  todos: string[];
}

function segmentToNoteLine(segment: TranscriptSegment): string {
  const timestamp = formatSegmentTimestamp(segment.startMs);
  return `[${timestamp}] ${getSpeakerLabel(segment)}: ${segment.text}`;
}

function getLocalNoteCandidates(
  segments: ReadonlyArray<TranscriptSegment>,
  pattern: RegExp,
): string[] {
  return segments
    .filter((segment) => !isTranscriptErrorSegment(segment))
    .filter((segment) => pattern.test(segment.text))
    .slice(-3)
    .map(segmentToNoteLine);
}

function buildLocalMeetingNotes(
  segments: ReadonlyArray<TranscriptSegment>,
): LocalMeetingNotes {
  const copyableSegments = segments.filter(
    (segment) => !isTranscriptErrorSegment(segment),
  );
  return {
    summary: copyableSegments.slice(-3).map(segmentToNoteLine),
    decisions: getLocalNoteCandidates(
      copyableSegments,
      /決定|合意|方針|採用|進め|開始|確定|やります|します/,
    ),
    todos: getLocalNoteCandidates(
      copyableSegments,
      /TODO|ToDo|タスク|対応|確認|次|期限|担当|レビュー|フォロー|送る|共有/,
    ),
  };
}

function formatLocalMeetingNotes(notes: LocalMeetingNotes): string {
  const section = (title: string, lines: ReadonlyArray<string>) => [
    `## ${title}`,
    ...(lines.length > 0
      ? lines.map((line) => `- ${line}`)
      : ["- まだありません。"]),
  ];
  return [
    "# 端末内会議ノート",
    "",
    ...section("要点", notes.summary),
    "",
    ...section("決定事項", notes.decisions),
    "",
    ...section("タスク", notes.todos),
    "",
    "※ 端末内で抽出。表示中の文字起こしは外部送信しません。",
  ].join("\n");
}

function getLocalMeetingNoteSections(notes: LocalMeetingNotes) {
  return [
    {
      key: "summary",
      label: "要点",
      items: notes.summary,
      empty: "発話後に要点を保持します。",
    },
    {
      key: "decisions",
      label: "決定",
      items: notes.decisions,
      empty: "決定事項を検出します。",
    },
    {
      key: "todos",
      label: "タスク",
      items: notes.todos,
      empty: "次アクションを検出します。",
    },
  ] as const;
}

function readLiveCaptionPreferences(): LiveCaptionPreferences {
  try {
    const raw = window.localStorage.getItem(
      LIVE_CAPTION_PREFERENCES_STORAGE_KEY,
    );
    if (!raw) {
      return defaultLiveCaptionPreferences;
    }
    const parsed = JSON.parse(raw) as Partial<LiveCaptionPreferences>;
    return {
      captionMode: isCaptionMode(parsed.captionMode)
        ? parsed.captionMode
        : defaultLiveCaptionPreferences.captionMode,
      aiNotesEnabled:
        typeof parsed.aiNotesEnabled === "boolean"
          ? parsed.aiNotesEnabled
          : defaultLiveCaptionPreferences.aiNotesEnabled,
      translationTarget: isTranslationTarget(parsed.translationTarget)
        ? parsed.translationTarget
        : defaultLiveCaptionPreferences.translationTarget,
    };
  } catch {
    return defaultLiveCaptionPreferences;
  }
}

function writeLiveCaptionPreferences(
  preferences: LiveCaptionPreferences,
): void {
  window.localStorage.setItem(
    LIVE_CAPTION_PREFERENCES_STORAGE_KEY,
    JSON.stringify(preferences),
  );
}

function readLiveCaptionAiQuestionState(): LiveCaptionAiQuestionState {
  try {
    const raw = window.localStorage.getItem(
      LIVE_CAPTION_AI_QUESTION_STORAGE_KEY,
    );
    if (!raw) {
      return { draft: "", queuedQuestion: null };
    }
    const parsed = JSON.parse(raw) as Partial<LiveCaptionAiQuestionState>;
    const queuedQuestion =
      typeof parsed.queuedQuestion === "string" && parsed.queuedQuestion.trim()
        ? parsed.queuedQuestion
        : null;
    return {
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
      queuedQuestion,
    };
  } catch {
    return { draft: "", queuedQuestion: null };
  }
}

function writeLiveCaptionAiQuestionState(
  state: LiveCaptionAiQuestionState,
): void {
  window.localStorage.setItem(
    LIVE_CAPTION_AI_QUESTION_STORAGE_KEY,
    JSON.stringify(state),
  );
}

async function hideLiveCaptionOverlayWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("set_live_caption_window_visible", { visible: false });
}

function createPreviewLatestBySource(): LatestBySource {
  return {
    microphone: PREVIEW_TRANSCRIPT_SEGMENTS[0],
    system_audio: PREVIEW_TRANSCRIPT_SEGMENTS[1],
  };
}

export function LiveCaptionWindow() {
  const isBrowserPreview = !isTauriRuntime();
  const [latestSegment, setLatestSegment] = useState<TranscriptSegment | null>(
    () =>
      isBrowserPreview
        ? PREVIEW_TRANSCRIPT_SEGMENTS[PREVIEW_TRANSCRIPT_SEGMENTS.length - 1]
        : null,
  );
  const [recentSegments, setRecentSegments] = useState<TranscriptSegment[]>(
    () => (isBrowserPreview ? PREVIEW_TRANSCRIPT_SEGMENTS : []),
  );
  const [latestBySource, setLatestBySource] = useState<LatestBySource>(() =>
    isBrowserPreview
      ? createPreviewLatestBySource()
      : createEmptyLatestBySource(),
  );
  const [statusPayload, setStatusPayload] = useState<LiveCaptionStatusPayload>(
    () =>
      isBrowserPreview
        ? PREVIEW_LIVE_CAPTION_STATUS
        : readStoredLiveCaptionStatus((e) => {
            console.error(
              "ライブ文字起こしステータスの読み取りに失敗しました:",
              toErrorMessage(e),
            );
          }),
  );
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [captionMode, setCaptionMode] = useState<CaptionMode>(
    () => readLiveCaptionPreferences().captionMode,
  );
  const [aiNotesEnabled, setAiNotesEnabled] = useState(
    () => readLiveCaptionPreferences().aiNotesEnabled,
  );
  const [translationTarget, setTranslationTarget] = useState<TranslationTarget>(
    () => readLiveCaptionPreferences().translationTarget,
  );
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [aiQuestionDraft, setAiQuestionDraft] = useState(
    () => readLiveCaptionAiQuestionState().draft,
  );
  const [queuedAiQuestion, setQueuedAiQuestion] = useState<string | null>(
    () => readLiveCaptionAiQuestionState().queuedQuestion,
  );
  const [translationCopyStatus, setTranslationCopyStatus] = useState<
    string | null
  >(null);
  const settings = useQuery<AppSettings>({
    queryKey: ["app-settings"],
    queryFn: () =>
      isTauriRuntime()
        ? invoke<AppSettings>("get_settings")
        : Promise.resolve(PREVIEW_APP_SETTINGS),
  });

  useEffect(() => {
    try {
      writeLiveCaptionPreferences({
        captionMode,
        aiNotesEnabled,
        translationTarget,
      });
      setPreferenceError(null);
    } catch (e) {
      console.error(
        "ライブ文字起こしの表示設定を保存できませんでした:",
        toErrorMessage(e),
      );
      setPreferenceError("ライブ文字起こしの表示設定を保存できませんでした");
    }
  }, [aiNotesEnabled, captionMode, translationTarget]);

  useEffect(() => {
    try {
      writeLiveCaptionAiQuestionState({
        draft: aiQuestionDraft,
        queuedQuestion: queuedAiQuestion,
      });
      setPreferenceError(null);
    } catch (e) {
      console.error(
        "質問準備を保存できませんでした:",
        toErrorMessage(e),
      );
      setPreferenceError("質問準備を保存できませんでした");
    }
  }, [aiQuestionDraft, queuedAiQuestion]);

  const resetLiveCaptionState = useCallback(() => {
    if (isBrowserPreview) {
      setLatestSegment(
        PREVIEW_TRANSCRIPT_SEGMENTS[PREVIEW_TRANSCRIPT_SEGMENTS.length - 1],
      );
      setRecentSegments(PREVIEW_TRANSCRIPT_SEGMENTS);
      setLatestBySource(createPreviewLatestBySource());
      setStatusPayload(PREVIEW_LIVE_CAPTION_STATUS);
      setListenerError(null);
      return;
    }
    setLatestSegment(null);
    setRecentSegments([]);
    setLatestBySource(createEmptyLatestBySource());
    setStatusPayload(
      readStoredLiveCaptionStatus((e) => {
        console.error(
          "ライブ文字起こしステータスの読み取りに失敗しました:",
          toErrorMessage(e),
        );
      }),
    );
    setListenerError(null);
  }, [isBrowserPreview]);

  useEffect(() => {
    resetLiveCaptionState();
  }, [resetLiveCaptionState]);

  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    let disposed = false;
    const handleListenerStartError = (label: string, e: unknown) => {
      const msg = toErrorMessage(e);
      console.error(`${label}の受信開始に失敗しました:`, msg);
      if (!disposed) {
        setListenerError("ライブ文字起こしを開始できませんでした。");
      }
      return null;
    };
    const statusUnlistenPromise = listen<unknown>(
      LIVE_CAPTION_STATUS_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        if (isLiveCaptionStatusPayload(event.payload)) {
          setListenerError((current) =>
            current?.startsWith(INVALID_STATUS_PAYLOAD_ERROR) ? null : current,
          );
          setStatusPayload(normalizeLiveCaptionStatusPayload(event.payload));
          return;
        }
        const issue = getLiveCaptionStatusPayloadIssue(event.payload);
        console.error("ライブ文字起こしの状態通知の形式が不正です:", issue);
        setListenerError(INVALID_STATUS_PAYLOAD_ERROR);
      },
    ).catch((e) => handleListenerStartError("ライブ文字起こしステータス", e));
    const resetUnlistenPromise = listen(LIVE_CAPTION_RESET_EVENT, () => {
      if (disposed) {
        return;
      }
      resetLiveCaptionState();
    }).catch((e) => handleListenerStartError("ライブ文字起こしリセット", e));
    const resultUnlistenPromise = listen<unknown>(
      TRANSCRIPTION_RESULT_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptSegmentPayload(payload)) {
          const issue = getTranscriptSegmentPayloadIssue(payload);
          console.error(
            "ライブ文字起こし結果の形式が不正です:",
            issue,
          );
          setListenerError("ライブ文字起こしを表示できませんでした。");
          return;
        }
        setListenerError(null);
        setStatusPayload(recoverLiveCaptionStatusOnValidResult);
        setLatestSegment(payload);
        setRecentSegments((prev) => [...prev, payload].slice(-2));
        if (payload.source) {
          setLatestBySource((prev) => ({
            ...prev,
            [payload.source as AudioSource]: payload,
          }));
        }
      },
    ).catch((e) => handleListenerStartError("ライブ文字起こし結果", e));
    const errorUnlistenPromise = listen<unknown>(
      TRANSCRIPTION_ERROR_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isTranscriptionErrorPayload(payload)) {
          const issue = getTranscriptionErrorPayloadIssue(payload);
          setStatusPayload(markLiveCaptionStatusOnError);
          console.error(
            "ライブ文字起こしエラー通知の形式が不正です:",
            issue,
          );
          setListenerError(
            "ライブ文字起こしのエラー状態を確認できませんでした。",
          );
          return;
        }
        setListenerError(null);
        setStatusPayload(markLiveCaptionStatusOnError);
        const errorSegment: TranscriptSegment = {
          text: `エラー: ${payload.error}`,
          startMs: 0,
          endMs: 0,
          source: payload.source,
          isError: true,
        };
        setLatestSegment(errorSegment);
        setRecentSegments([errorSegment]);
        if (payload.source) {
          setLatestBySource((prev) => ({
            ...prev,
            [payload.source as AudioSource]: errorSegment,
          }));
        } else {
          setLatestBySource(createEmptyLatestBySource());
        }
      },
    ).catch((e) => handleListenerStartError("ライブ文字起こしエラー", e));

    Promise.all([
      statusUnlistenPromise,
      resetUnlistenPromise,
      resultUnlistenPromise,
      errorUnlistenPromise,
    ])
      .then((unlisteners) => {
        if (!disposed && unlisteners.every((unlisten) => unlisten !== null)) {
          setListenerError((current) =>
            current === "ライブ文字起こしを開始できませんでした。"
              ? null
              : current,
          );
        }
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("ライブ文字起こしの受信開始に失敗しました:", msg);
          setListenerError("ライブ文字起こしを開始できませんでした。");
        }
      });

    return () => {
      disposed = true;
      resetUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) =>
          console.error(
            "ライブ文字起こしリセットの受信解除に失敗しました:",
            toErrorMessage(e),
          ),
        );
      resultUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) =>
          console.error(
            "ライブ文字起こし結果の受信解除に失敗しました:",
            toErrorMessage(e),
          ),
        );
      errorUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) =>
          console.error(
            "ライブ文字起こしエラーの受信解除に失敗しました:",
            toErrorMessage(e),
          ),
        );
      statusUnlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) =>
          console.error(
            "ライブ文字起こしステータスの受信解除に失敗しました:",
            toErrorMessage(e),
          ),
        );
    };
  }, [isBrowserPreview, resetLiveCaptionState]);

  const isErrorState = Boolean(
    listenerError || isTranscriptErrorSegment(latestSegment),
  );
  const captionTimestamp =
    latestSegment && !isTranscriptErrorSegment(latestSegment)
      ? formatSegmentTimestamp(latestSegment.startMs)
      : null;
  const trackStatusLabels = TRACKS.map((track) => {
    const captureLabel =
      track.source === "microphone"
        ? statusPayload.microphoneTrackLabel
        : statusPayload.systemAudioTrackLabel;
    const captureState = getTrackCaptureState(captureLabel);
    const state = getTrackStateLabel(
      latestBySource[track.source],
      captureLabel,
    );
    return {
      ...track,
      captureState,
      state,
      ariaLabel: `${track.ariaPrefix}: ${state}`,
    };
  });
  const visibleTrackSummary = getVisibleTrackSummary(statusPayload);
  const transcriptionStatusAriaLabel = `文字起こし状態: ${statusPayload.transcriptionStatusLabel}`;
  const transmissionStatusAriaLabel =
    getTransmissionStatusAriaLabel(statusPayload);
  const label = listenerError
    ? `${listenerError}: ${transcriptionStatusAriaLabel}`
    : latestSegment
      ? [
          "ライブ文字起こし",
          getSpeakerLabel(latestSegment),
          transcriptionStatusAriaLabel,
          captionTimestamp ? `発話時刻 ${captionTimestamp}` : null,
          ...trackStatusLabels.map(
            (track) => `${track.ariaPrefix} ${track.state}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          transmissionStatusAriaLabel,
          latestSegment.text,
        ]
          .filter(Boolean)
          .join(": ")
      : [
          "ライブ文字起こし 待機中",
          transcriptionStatusAriaLabel,
          ...trackStatusLabels.map(
            (track) => `${track.ariaPrefix} ${track.state}`,
          ),
          `エンジン ${statusPayload.engineLabel}`,
          transmissionStatusAriaLabel,
          WAITING_CAPTION_ARIA_TEXT,
        ].join(": ");
  const panelClassName = isErrorState
    ? "live-transcript-panel live-transcript-panel-window live-transcript-panel-error"
    : "live-transcript-panel live-transcript-panel-window";
  const liveCaptionRole = isErrorState ? "alert" : "status";
  const aiMinutesProvider = settings.data?.aiMinutesProvider ?? "none";
  const isExternalAiMinutesProvider =
    EXTERNAL_AI_MINUTES_PROVIDERS.has(aiMinutesProvider);
  const isLocalAiMinutesProvider = aiMinutesProvider === "ollama";
  const aiProviderConnectionLabel = settings.isLoading
    ? "AI設定確認中"
    : settings.error
      ? "AI設定確認失敗"
      : aiMinutesProvider === "none"
        ? "端末内抽出"
        : isLocalAiMinutesProvider
          ? "端末内AI"
          : "手動コピー確認";
  const aiProviderTransmissionLabel = settings.error
    ? "議事録設定を確認できませんでした"
    : isExternalAiMinutesProvider
      ? "AI外部送信は手動コピー時に確認"
      : isLocalAiMinutesProvider
        ? "端末内・AI外部送信なし"
        : "AI外部送信なし";
  const aiProviderCompactTransmissionLabel = settings.error
    ? "AI確認失敗"
    : isExternalAiMinutesProvider
      ? "手動コピー確認"
      : isLocalAiMinutesProvider
        ? "端末内AI"
        : "AI外部送信なし";
  const aiNotesConnectionDisplayLabel = aiNotesEnabled
    ? aiProviderConnectionLabel
    : "AIオフ";
  const aiNotesTransmissionDisplayLabel = aiNotesEnabled
    ? aiProviderCompactTransmissionLabel
    : "外部送信なし";
  const aiNotesConnectionAriaLabel = aiNotesEnabled
    ? `ノート接続: ${aiProviderConnectionLabel}。${aiProviderTransmissionLabel}`
    : "ノート接続: AIオフ。AI外部送信なし";
  const aiNotesConnectionTitle = aiNotesEnabled
    ? aiProviderTransmissionLabel
    : "AIノートはオフです。AI外部送信はありません。";
  const meetingNotesModeLabel = isExternalAiMinutesProvider
    ? "端末内抽出・手動コピー確認"
    : isLocalAiMinutesProvider
      ? "端末内抽出・端末内AI"
      : "端末内抽出";
  const meetingNotesModeTitle = isExternalAiMinutesProvider
    ? "表示中の文字起こしから端末内で抽出します。外部プロバイダーへ送る場合は手動コピー時に確認します。"
    : isLocalAiMinutesProvider
      ? "表示中の文字起こしから端末内で抽出します。AI外部送信はありません。"
      : "表示中の文字起こしから端末内で抽出します。AI外部送信はありません。";
  const transcriptLines =
    recentSegments.length > 0
      ? recentSegments
      : latestSegment
        ? [latestSegment]
        : [];
  const copyableTranscriptLineCount = transcriptLines.filter(
    (segment) => !isTranscriptErrorSegment(segment),
  ).length;
  const localMeetingNotes = buildLocalMeetingNotes(transcriptLines);
  const localMeetingNoteSections =
    getLocalMeetingNoteSections(localMeetingNotes);
  const hasLocalMeetingNotes = localMeetingNoteSections.some(
    (section) => section.items.length > 0,
  );
  const localMeetingNoteItemCount = localMeetingNoteSections.reduce(
    (count, section) => count + section.items.length,
    0,
  );
  const copyVisibleTranscriptSource = useCallback(() => {
    const copyableLines = transcriptLines.filter(
      (segment) => !isTranscriptErrorSegment(segment),
    );
    if (copyableLines.length === 0) {
      setTranslationCopyStatus("コピーできる原文がありません");
      return;
    }
    const text = copyableLines
      .map((segment) => {
        const timestamp = formatSegmentTimestamp(segment.startMs);
        const speaker = getSpeakerLabel(segment);
        return `[${timestamp}] ${speaker}: ${segment.text}`;
      })
      .join("\n");
    void writeClipboardText(text)
      .then(() => {
        setTranslationCopyStatus("原文をコピーしました");
      })
      .catch((e) => {
        console.error("原文をコピーできませんでした:", toErrorMessage(e));
        setTranslationCopyStatus("原文をコピーできませんでした");
      });
  }, [transcriptLines]);
  const shouldShowExpandedWaitingSurface =
    statusPayload.transcriptionStatusLabel === "開始中" ||
    statusPayload.transcriptionStatusLabel === "文字起こし中";
  const isWaitingState =
    transcriptLines.length === 0 &&
    !listenerError &&
    !shouldShowExpandedWaitingSurface;
  const compactCaptionLabel =
    statusPayload.transcriptionStatusLabel === "文字起こし中"
      ? "文字起こし中"
      : `文字起こし ${statusPayload.transcriptionStatusLabel}`;
  const compactRecLabel = `REC ${statusPayload.transcriptionStatusLabel}`;
  const compactNotesLabel = !aiNotesEnabled
    ? "AIオフ"
    : queuedAiQuestion
      ? "質問準備"
      : isExternalAiMinutesProvider
        ? "手動コピー確認"
        : "端末内AI";
  const compactAiClassName = !aiNotesEnabled
    ? "live-caption-compact-ai live-caption-compact-ai-muted"
    : queuedAiQuestion || isExternalAiMinutesProvider
      ? "live-caption-compact-ai live-caption-compact-ai-warn"
      : "live-caption-compact-ai live-caption-compact-ai-safe";
  const compactTransmissionLabel = statusPayload.isExternalTransmission
    ? "音声外部送信"
    : "音声外部送信なし";
  const compactTransmissionClassName = statusPayload.isExternalTransmission
    ? "live-caption-compact-ai live-caption-compact-ai-warn"
    : "live-caption-compact-ai live-caption-compact-ai-safe";
  const liveCaptionStorageLabel =
    "録音履歴、文字起こし、音声トラックはこのMacに保存します。";
  const compactStatusLabel = [
    compactRecLabel,
    visibleTrackSummary,
    `ノート ${compactNotesLabel}`,
    aiNotesEnabled
      ? "AIノートは表示中の文字起こしから作成し、質問はここでは未送信です"
      : "AIノートはオフです",
    compactTransmissionLabel,
    transmissionStatusAriaLabel,
  ].join("。");
  const liveCaptionHeadingStatusLabel =
    captionTimestamp ?? statusPayload.transcriptionStatusLabel;
  const hideLiveCaptionWindow = () => {
    void hideLiveCaptionOverlayWindow().catch((e) => {
      const msg = toErrorMessage(e);
      console.error("ライブ文字起こしウィンドウを隠せませんでした:", msg);
      setListenerError("ライブ文字起こしを閉じられませんでした。");
    });
  };
  const translationTargetOption = getTranslationTargetOption(translationTarget);
  const transcriptTabLabel = `リアルタイム文字起こしを表示。${visibleTrackSummary}を時刻順に表示し、${transmissionStatusAriaLabel}。`;
  const translationTabLabel = `リアルタイム翻訳ビューを表示。現在は翻訳エンジン未接続のため原文プレビューのみ、翻訳先設定 ${translationTargetOption.label} を保存し、翻訳外部送信なし。`;
  const translationViewStateLabel = `翻訳未接続 · 原文のみ · ${translationTargetOption.shortLabel}設定保存 · 外部送信なし`;
  const translationTargetGroupLabel = `翻訳先の選択。現在は${TRANSLATION_ENGINE_LABEL}のため、翻訳先設定だけ保存します。表示中の原文と音声トラックは翻訳外部送信しません。`;
  const copyVisibleSourceLabel = `表示中の原文をコピー。${visibleTrackSummary}の文字起こし原文をコピーし、翻訳外部送信はありません。`;
  const translationBoundaryFlow = [
    {
      label: "原文",
      value:
        copyableTranscriptLineCount > 0
          ? `${copyableTranscriptLineCount}発話`
          : "発話待ち",
      tone: copyableTranscriptLineCount > 0 ? "accent" : "muted",
    },
    {
      label: "翻訳先",
      value: translationTargetOption.shortLabel,
      tone: "accent",
    },
    {
      label: "出力",
      value: "原文プレビュー",
      tone: "warn",
    },
    {
      label: "送信",
      value: "外部送信なし",
      tone: "safe",
    },
  ] as const;
  const translationBoundaryFlowLabel = [
    "リアルタイム翻訳の状態",
    `原文 ${copyableTranscriptLineCount} 発話`,
    `翻訳先 ${translationTargetOption.label}`,
    `${TRANSLATION_ENGINE_LABEL}のため出力は原文プレビュー`,
    "表示中の原文と音声トラックは翻訳外部送信しません",
  ].join("。");
  const copyLocalMeetingNotesLabel = `端末内会議ノートをコピー。表示中の文字起こしから端末内抽出したノートをコピーし、${aiProviderTransmissionLabel}。`;
  const liveNotesPanelLabel = `AIノートと質問準備。${aiNotesConnectionAriaLabel}。表示中の文字起こしから会議ノートを作り、質問はここでは未送信です。`;
  const aiNotesToggleLabel = aiNotesEnabled
    ? `AIノートをオフにする。表示中の文字起こしから作る会議ノートと質問準備を隠します。${aiProviderTransmissionLabel}。`
    : `AIノートをオンにする。表示中の文字起こしから会議ノートと未送信の質問準備を表示します。${aiProviderTransmissionLabel}。`;
  const liveNotesRuntimeFlow = [
    {
      label: "入力",
      value:
        copyableTranscriptLineCount > 0
          ? `${copyableTranscriptLineCount}発話`
          : "発話待ち",
      tone: copyableTranscriptLineCount > 0 ? "accent" : "muted",
    },
    {
      label: "ノート",
      value: aiNotesEnabled
        ? localMeetingNoteItemCount > 0
          ? `${localMeetingNoteItemCount}項目`
          : "抽出待ち"
        : "オフ",
      tone: aiNotesEnabled ? "safe" : "muted",
    },
    {
      label: "質問",
      value: queuedAiQuestion ? "準備済み" : "未送信",
      tone: queuedAiQuestion ? "safe" : "muted",
    },
    {
      label: "送信",
      value: aiNotesEnabled ? aiProviderCompactTransmissionLabel : "なし",
      tone:
        aiNotesEnabled && isExternalAiMinutesProvider
          ? "warn"
          : aiNotesEnabled
            ? "safe"
            : "muted",
    },
  ] as const;
  const liveNotesRuntimeFlowLabel = [
    "AIノートの状態",
    `入力 ${copyableTranscriptLineCount} 発話`,
    `ノート ${aiNotesEnabled ? `${localMeetingNoteItemCount} 項目` : "オフ"}`,
    `質問 ${queuedAiQuestion ? "準備済み" : "未送信"}`,
    aiNotesEnabled ? aiProviderTransmissionLabel : "AI外部送信なし",
  ].join("。");
  const aiQuestionSurfaceLabel = `会議内容への質問準備。ここではAI外部送信せず、未送信の質問を手動コピーできます。${aiProviderTransmissionLabel}。`;
  const aiQuestionBoundaryLabel = [
    "未送信",
    isExternalAiMinutesProvider ? "外部AIは手動コピー時に確認" : "外部送信なし",
    "音声トラックは送信しません",
  ].join(" · ");
  const aiQuestionMaterialFlow = [
    {
      label: "素材",
      value:
        copyableTranscriptLineCount > 0
          ? `${copyableTranscriptLineCount}発話`
          : "発話待ち",
      tone: copyableTranscriptLineCount > 0 ? "accent" : "muted",
    },
    {
      label: "ノート",
      value:
        localMeetingNoteItemCount > 0
          ? `${localMeetingNoteItemCount}項目`
          : "抽出待ち",
      tone: localMeetingNoteItemCount > 0 ? "safe" : "muted",
    },
    {
      label: "質問",
      value: queuedAiQuestion ? "準備済み" : "未送信",
      tone: queuedAiQuestion ? "safe" : "neutral",
    },
    {
      label: "音声",
      value: "送信なし",
      tone: "safe",
    },
    {
      label: "送信",
      value: isExternalAiMinutesProvider ? "手動確認" : "外部送信なし",
      tone: isExternalAiMinutesProvider ? "warn" : "safe",
    },
  ] as const;
  const aiQuestionMaterialFlowLabel = [
    "質問の素材",
    `表示中の文字起こし ${copyableTranscriptLineCount} 発話`,
    `会議ノート ${localMeetingNoteItemCount} 項目`,
    "質問はここでは未送信",
    "音声トラックは送信しません",
    aiProviderTransmissionLabel,
  ].join("。");
  const aiQuestionStateLabel = queuedAiQuestion
    ? "未送信の質問あり"
    : "未送信 · コピー準備";
  const liveCaptionModeFlow = [
    {
      label: "文字起こし",
      value:
        copyableTranscriptLineCount > 0
          ? `${copyableTranscriptLineCount}発話`
          : statusPayload.transcriptionStatusLabel,
      tone: copyableTranscriptLineCount > 0 ? "accent" : "neutral",
    },
    {
      label: "翻訳",
      value:
        captionMode === "translation"
          ? `${translationTargetOption.shortLabel} 原文`
          : "待機",
      tone: captionMode === "translation" ? "accent" : "neutral",
    },
    {
      label: "AIノート",
      value: aiNotesEnabled
        ? localMeetingNoteItemCount > 0
          ? `${localMeetingNoteItemCount}項目`
          : "抽出待ち"
        : "オフ",
      tone: aiNotesEnabled
        ? localMeetingNoteItemCount > 0
          ? "safe"
          : "accent"
        : "muted",
    },
    {
      label: "質問",
      value: queuedAiQuestion ? "準備済み" : "未送信",
      tone: queuedAiQuestion ? "safe" : "neutral",
    },
  ] as const;
  const liveCaptionModeFlowLabel = [
    "録音中の表示モード",
    `文字起こし ${copyableTranscriptLineCount} 発話`,
    `翻訳 ${captionMode === "translation" ? translationTargetOption.label : "待機"}`,
    `AIノート ${aiNotesEnabled ? "オン" : "オフ"}`,
    `質問 ${queuedAiQuestion ? "準備済み" : "未送信"}`,
    aiProviderTransmissionLabel,
  ].join("。");
  const normalizedAiQuestionDraft = aiQuestionDraft.trim();
  const canQueueAiQuestion =
    aiNotesEnabled && normalizedAiQuestionDraft.length > 0;
  const shouldShowAiQuestionSurface =
    aiNotesEnabled || Boolean(queuedAiQuestion);
  const handleSelectQuestionSuggestion = useCallback((suggestion: string) => {
    setAiQuestionDraft(suggestion);
    setQueuedAiQuestion(null);
  }, []);
  const handleQueueAiQuestion = useCallback(() => {
    if (!canQueueAiQuestion) {
      return;
    }
    setQueuedAiQuestion(normalizedAiQuestionDraft);
    setAiQuestionDraft("");
  }, [canQueueAiQuestion, normalizedAiQuestionDraft]);
  const handleCopyQueuedAiQuestion = useCallback(() => {
    if (!queuedAiQuestion) {
      return;
    }
    void writeClipboardText(queuedAiQuestion).catch((e) => {
      console.error("質問をコピーできませんでした:", toErrorMessage(e));
      setPreferenceError("質問をコピーできませんでした");
    });
  }, [queuedAiQuestion]);
  const handleCopyLocalMeetingNotes = useCallback(() => {
    void writeClipboardText(formatLocalMeetingNotes(localMeetingNotes))
      .then(() => {
        setPreferenceError(null);
      })
      .catch((e) => {
        console.error(
          "端末内会議ノートをコピーできませんでした:",
          toErrorMessage(e),
        );
        setPreferenceError("会議ノートをコピーできませんでした");
      });
  }, [localMeetingNotes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideLiveCaptionWindow();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  if (isWaitingState) {
    return (
      <div
        className="overlay-window live-caption-window live-caption-window-compact"
        data-tauri-drag-region
        role={liveCaptionRole}
        aria-live="polite"
        aria-atomic="true"
        aria-label={label}
        title={label}
      >
        <div
          className="live-caption-compact-pill"
          data-tauri-drag-region
          aria-label={compactStatusLabel}
          title={compactStatusLabel}
        >
          <span className="live-caption-compact-dot" aria-hidden="true" />
          <span className="live-caption-compact-rec" data-tauri-drag-region>
            REC
          </span>
          <span className="live-caption-compact-text" data-tauri-drag-region>
            {compactCaptionLabel}
          </span>
          <span
            className="live-caption-compact-track"
            data-tauri-drag-region
            aria-label={`録音トラック ${visibleTrackSummary}`}
            title={`録音トラック ${visibleTrackSummary}`}
          >
            {visibleTrackSummary}
          </span>
          <span className={compactAiClassName} data-tauri-drag-region>
            {compactNotesLabel}
          </span>
          <span
            className={compactTransmissionClassName}
            data-tauri-drag-region
          >
            {compactTransmissionLabel}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="overlay-window live-caption-window"
      data-tauri-drag-region
      role={liveCaptionRole}
      aria-live={isErrorState ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={label}
      title={label}
    >
      <div className={panelClassName} data-tauri-drag-region>
        <div className="live-transcript-status-row" data-tauri-drag-region>
          <span className="live-transcript-rec-pill" data-tauri-drag-region>
            <span aria-hidden="true" />
            REC
          </span>
          <strong
            className="live-transcript-meeting-title"
            data-tauri-drag-region
          >
            録音中 · {liveCaptionHeadingStatusLabel}
          </strong>
          <span
            className="live-transcript-health-pill"
            data-tauri-drag-region
            aria-label={`音声トラック状態。${visibleTrackSummary}`}
            title={`音声トラック状態。${visibleTrackSummary}`}
          >
            {visibleTrackSummary}
          </span>
          <span
            className={
              statusPayload.isExternalTransmission
                ? "live-transcript-boundary-pill live-transcript-boundary-pill-warn"
                : "live-transcript-boundary-pill live-transcript-boundary-pill-safe"
            }
            data-tauri-drag-region
            aria-label={transmissionStatusAriaLabel}
            title={transmissionStatusAriaLabel}
          >
            {compactTransmissionLabel}
          </span>
          <span
            className="live-transcript-storage-pill"
            data-tauri-drag-region
            aria-label={liveCaptionStorageLabel}
            title={liveCaptionStorageLabel}
          >
            このMacに保存
          </span>
          <span
            className="live-transcript-status-spacer"
            data-tauri-drag-region
          />
          <button
            type="button"
            className="live-transcript-minimize-btn"
            aria-label={`${LIVE_CAPTION_CLOSE_LABEL}。${transcriptionStatusAriaLabel}`}
            aria-keyshortcuts="Escape"
            title={`${LIVE_CAPTION_CLOSE_LABEL}。${transcriptionStatusAriaLabel}`}
            onClick={hideLiveCaptionWindow}
          >
            <Minus aria-hidden="true" size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="live-transcript-content" data-tauri-drag-region>
          <div className="live-transcript-stream" data-tauri-drag-region>
            <div className="live-transcript-tabs" data-tauri-drag-region>
              <button
                type="button"
                className={
                  captionMode === "transcript"
                    ? "live-transcript-tab live-transcript-tab-active"
                    : "live-transcript-tab"
                }
                aria-pressed={captionMode === "transcript"}
                aria-label={transcriptTabLabel}
                title={transcriptTabLabel}
                onClick={() => setCaptionMode("transcript")}
              >
                文字起こし
              </button>
              <button
                type="button"
                className={
                  captionMode === "translation"
                    ? "live-transcript-tab live-transcript-tab-active"
                    : "live-transcript-tab"
                }
                aria-pressed={captionMode === "translation"}
                aria-label={translationTabLabel}
                title={translationTabLabel}
                onClick={() => setCaptionMode("translation")}
              >
                <Languages size={12} aria-hidden="true" />
                翻訳 {translationTargetOption.shortLabel}
              </button>
              {preferenceError && (
                <span
                  className="live-caption-preference-pill live-caption-preference-pill-error"
                  data-tauri-drag-region
                  role="status"
                  aria-label={preferenceError}
                  title={preferenceError}
                >
                  設定保存失敗
                </span>
              )}
            </div>

            <div
              className="live-caption-mode-flow"
              role="status"
              aria-label={liveCaptionModeFlowLabel}
              title={liveCaptionModeFlowLabel}
              data-tauri-drag-region
            >
              {liveCaptionModeFlow.map((item) => (
                <span
                  key={`${item.label}-${item.value}`}
                  className={`live-caption-mode-chip live-caption-mode-chip-${item.tone}`}
                  data-tauri-drag-region
                >
                  <small data-tauri-drag-region>{item.label}</small>
                  <strong data-tauri-drag-region>{item.value}</strong>
                </span>
              ))}
            </div>

            <div className="live-transcript-lines" data-tauri-drag-region>
              {captionMode === "translation" && (
                <div
                  className="live-transcript-translation-note"
                  role="status"
                  aria-label={`翻訳ビュー: ${translationTargetOption.label}。${translationViewStateLabel}。`}
                  title={`翻訳ビューは${TRANSLATION_ENGINE_LABEL}です。${translationViewStateLabel}。`}
                >
	                  <span
	                    className="live-transcript-translation-state"
	                    data-tauri-drag-region
	                  >
	                    {translationViewStateLabel}
	                  </span>
	                  <div
	                    className="live-transcript-translation-flow"
	                    role="status"
	                    aria-label={translationBoundaryFlowLabel}
	                    title={translationBoundaryFlowLabel}
	                  >
	                    {translationBoundaryFlow.map((item) => (
	                      <span
	                        key={`${item.label}-${item.value}`}
	                        className={`live-transcript-translation-flow-chip live-transcript-translation-flow-chip-${item.tone}`}
	                        data-tauri-drag-region
	                      >
	                        <span data-tauri-drag-region>{item.label}</span>
	                        <strong data-tauri-drag-region>{item.value}</strong>
	                      </span>
	                    ))}
	                  </div>
		                  <div
		                    className="live-transcript-translation-targets"
		                    role="group"
	                    aria-label={translationTargetGroupLabel}
	                    title={translationTargetGroupLabel}
	                  >
                    {TRANSLATION_TARGET_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={
                          translationTarget === option.value
                            ? "live-transcript-translation-target live-transcript-translation-target-active"
                            : "live-transcript-translation-target"
                        }
	                        aria-pressed={translationTarget === option.value}
	                        aria-label={`翻訳先を ${option.label} に設定。現在は${TRANSLATION_ENGINE_LABEL}のため原文のみ表示し、翻訳外部送信はありません。`}
	                        title={`翻訳先を ${option.label} に設定。現在は原文のみ表示し、翻訳外部送信なし。`}
	                        onClick={() => setTranslationTarget(option.value)}
	                      >
                        {option.shortLabel}
                      </button>
                    ))}
                  </div>
                  <div className="live-transcript-translation-actions">
                    {transcriptLines.length > 0 ? (
                      <button
                        type="button"
                        onClick={copyVisibleTranscriptSource}
                        aria-label={copyVisibleSourceLabel}
                        title={copyVisibleSourceLabel}
                      >
                        <Clipboard size={10} aria-hidden="true" />
                        原文コピー
                      </button>
                    ) : null}
                    {translationCopyStatus && (
                      <span role="status" aria-live="polite">
                        {translationCopyStatus}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {transcriptLines.length > 0 ? (
                transcriptLines.map((segment, index) => {
                  const timestamp = isTranscriptErrorSegment(segment)
                    ? "!"
                    : formatSegmentTimestamp(segment.startMs);
                  return (
                    <div
                      className={`live-transcript-line ${
                        isTranscriptErrorSegment(segment)
                          ? "live-transcript-line-error"
                          : ""
                      }`}
                      key={`${segment.startMs}-${segment.endMs}-${index}`}
                      data-tauri-drag-region
                    >
                      <span
                        className="live-transcript-timestamp"
                        data-tauri-drag-region
                      >
                        {timestamp}
                      </span>
                      <span
                        className={getSpeakerClassName(segment)}
                        data-tauri-drag-region
                      >
                        {getSpeakerLabel(segment)}
                      </span>
                      <span
                        className="live-transcript-text"
                        data-tauri-drag-region
                      >
                        {captionMode === "translation" &&
                        !isTranscriptErrorSegment(segment) ? (
                          <span
                            className="live-transcript-translation-preview"
                            data-tauri-drag-region
                          >
                            <strong data-tauri-drag-region>
                              翻訳未接続 · 原文のみ
                            </strong>
                            <small data-tauri-drag-region>{segment.text}</small>
                          </span>
                        ) : (
                          segment.text
                        )}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="live-transcript-line" data-tauri-drag-region>
                  <span
                    className="live-transcript-timestamp"
                    data-tauri-drag-region
                  >
                    --
                  </span>
                  <span
                    className="live-transcript-speaker live-transcript-speaker-unknown"
                    data-tauri-drag-region
                  >
                    発話待ち
                  </span>
                  <span className="live-transcript-text" data-tauri-drag-region>
                    {listenerError ?? WAITING_CAPTION_TEXT}
                  </span>
                </div>
              )}
            </div>
          </div>

          <aside
            className="live-transcript-tools"
            data-tauri-drag-region
            aria-label={liveNotesPanelLabel}
            title={liveNotesPanelLabel}
          >
            <div className="live-notes-head" data-tauri-drag-region>
              <strong data-tauri-drag-region>AIノート</strong>
              <span
                className="live-notes-connection-pill"
                data-tauri-drag-region
                aria-label={aiNotesConnectionAriaLabel}
                title={aiNotesConnectionTitle}
              >
                {aiNotesConnectionDisplayLabel} ·{" "}
                {aiNotesTransmissionDisplayLabel}
              </span>
              <button
                type="button"
                className={
                  aiNotesEnabled
                    ? "live-notes-toggle live-notes-toggle-on"
                    : "live-notes-toggle"
	                }
	                aria-pressed={aiNotesEnabled}
	                aria-label={aiNotesToggleLabel}
	                title={aiNotesToggleLabel}
	                onClick={() => setAiNotesEnabled((current) => !current)}
	              >
                <Sparkles size={12} aria-hidden="true" />
                {aiNotesEnabled ? "AIオン" : "AIオフ"}
              </button>
            </div>
            <div
              className="live-notes-runtime-flow"
              role="status"
              aria-label={liveNotesRuntimeFlowLabel}
              title={liveNotesRuntimeFlowLabel}
              data-tauri-drag-region
            >
              {liveNotesRuntimeFlow.map((item) => (
                <span
                  key={`${item.label}-${item.value}`}
                  className={`live-notes-runtime-chip live-notes-runtime-chip-${item.tone}`}
                  data-tauri-drag-region
                >
                  <span data-tauri-drag-region>{item.label}</span>
                  <strong data-tauri-drag-region>{item.value}</strong>
                </span>
              ))}
            </div>
            {preferenceError && (
              <div className="live-notes-preference-error" role="alert">
                {preferenceError}
              </div>
            )}
            {!aiNotesEnabled && (
              <div
                className="live-notes-off-state"
                role="status"
                aria-label="AIノートはオフです。AI外部送信はありません。オンにすると会議ノートと質問準備を表示します。"
                title="AIノートはオフです。AI外部送信はありません。"
                data-tauri-drag-region
              >
                <strong data-tauri-drag-region>AIノートはオフ</strong>
                <span data-tauri-drag-region>
                  オンにすると表示中の文字起こしから会議ノートと質問準備を作ります。
                </span>
              </div>
            )}
            {aiNotesEnabled && (
              <div className="live-notes-card" data-tauri-drag-region>
                <div
                  className="live-notes-local-preview"
                  data-tauri-drag-region
                  aria-label={`会議ノート: ${meetingNotesModeLabel}`}
                  title={meetingNotesModeTitle}
                >
                  <div
                    className="live-notes-local-preview-head"
                    data-tauri-drag-region
                  >
                    <span data-tauri-drag-region>会議ノート</span>
                    <small
                      className="live-notes-local-mode"
                      data-tauri-drag-region
                    >
                      {meetingNotesModeLabel}
                    </small>
                    {hasLocalMeetingNotes ? (
                      <button
                        type="button"
                        onClick={handleCopyLocalMeetingNotes}
                        aria-label={copyLocalMeetingNotesLabel}
                        title={copyLocalMeetingNotesLabel}
                      >
                        <Clipboard size={10} aria-hidden="true" />
                        会議ノートコピー
                      </button>
                    ) : null}
                  </div>
                  <div
                    className="live-notes-local-preview-sections"
                    data-tauri-drag-region
                  >
                    {localMeetingNoteSections.map((section) => (
                      <section
                        className="live-notes-local-preview-section"
                        key={section.key}
                        data-tauri-drag-region
                      >
                        <span data-tauri-drag-region>{section.label}</span>
                        <ul className="live-notes-local-preview-list">
                          {(section.items.length > 0
                            ? section.items.slice(-2)
                            : [section.empty]
                          ).map((line, index) => (
                            <li key={`${section.key}-${line}-${index}`}>
                              {line}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {shouldShowAiQuestionSurface && (
              <div
                className="live-notes-question"
                role="group"
                aria-label={aiQuestionSurfaceLabel}
                title={aiQuestionSurfaceLabel}
              >
                <div
                  className="live-notes-question-head"
                  data-tauri-drag-region
                >
                  <MessageSquareText size={12} aria-hidden="true" />
                  <span data-tauri-drag-region>質問準備</span>
                  <small data-tauri-drag-region>{aiQuestionStateLabel}</small>
                </div>
                <p
                  className={
                    isExternalAiMinutesProvider
                      ? "live-notes-question-boundary live-notes-question-boundary-warn"
                      : "live-notes-question-boundary"
                  }
                  aria-label={`${aiQuestionBoundaryLabel}。${aiProviderTransmissionLabel}`}
                  title={`${aiQuestionBoundaryLabel}。${aiProviderTransmissionLabel}`}
                  data-tauri-drag-region
                >
                  {aiQuestionBoundaryLabel}
                </p>
                <div
                  className="live-notes-question-material-flow"
                  role="status"
                  aria-label={aiQuestionMaterialFlowLabel}
                  title={aiQuestionMaterialFlowLabel}
                >
                  {aiQuestionMaterialFlow.map((item) => (
                    <span
                      key={`${item.label}-${item.value}`}
                      className={`live-notes-question-material-chip live-notes-question-material-chip-${item.tone}`}
                    >
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </span>
                  ))}
                </div>
                {aiNotesEnabled && (
                  <div className="live-notes-question-suggestions" role="list">
                    {AI_QUESTION_SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() =>
                          handleSelectQuestionSuggestion(suggestion)
                        }
                        title="質問欄に入れます。ここではAI外部送信しません。"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
                {queuedAiQuestion && (
                  <div
                    className="live-notes-question-queued"
                    role="status"
                    aria-live="polite"
                    aria-label="質問準備済み。ここでは未送信です。"
                    title="ここではAI外部送信していません。"
                  >
                    <strong data-tauri-drag-region>質問準備済み</strong>
                    <span data-tauri-drag-region>{queuedAiQuestion}</span>
                    <button
                      type="button"
                      onClick={handleCopyQueuedAiQuestion}
                      aria-label="未送信の質問を手動コピー"
                      title="未送信の質問を手動コピーします。ここではAI外部送信しません。"
                    >
                      <Clipboard size={10} aria-hidden="true" />
                      質問コピー
                    </button>
                  </div>
                )}
                {aiNotesEnabled && (
                  <div className="live-notes-question-input-row">
                    <input
                      type="text"
                      value={aiQuestionDraft}
                      onChange={(event) => {
                        setAiQuestionDraft(event.target.value);
                        setQueuedAiQuestion(null);
                      }}
                      aria-label="会議内容について質問を準備。ここではAI外部送信しません。"
                      placeholder="例: 決定事項は？"
                    />
                    {canQueueAiQuestion ? (
                      <button
                        type="button"
                        aria-label="未送信の質問を準備"
                        title={`${aiProviderTransmissionLabel}。質問はここでは未送信で、手動コピーできます。`}
                        onClick={handleQueueAiQuestion}
                      >
                        <SendHorizontal size={12} aria-hidden="true" />
                        <span>質問を準備</span>
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
