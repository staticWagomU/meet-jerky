import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Clipboard,
  ExternalLink,
  FileText,
  Search,
} from "lucide-react";
import { useSessionContent } from "../hooks/useSessionContent";
import { useSessionList } from "../hooks/useSessionList";
import {
  type SessionAudioAsset,
  useSessionAudioAssets,
} from "../hooks/useSessionAudioAssets";
import { parseSessionMarkdown } from "../utils/sessionContentParser";
import {
  getCompactSessionTitle,
  getFileName,
} from "../utils/transcriptViewFormatters";
import { getSessionStartedAtDisplay } from "../utils/sessionListHelpers";
import { toErrorMessage } from "../utils/errorMessage";
import { writeClipboardText } from "../utils/clipboard";
import type { AiMinutesProvider, AppSettings } from "../types";
import { isTauriRuntime } from "../utils/browserRuntime";
import { PREVIEW_APP_SETTINGS } from "../utils/previewAppData";

type PlaybackTrack = "both" | "self" | "other";

const minutesTemplateOptions = [
  "週次定例",
  "1on1",
  "採用面接",
  "顧客定例",
] as const;

type MinutesTemplateName = (typeof minutesTemplateOptions)[number];

const defaultMinutesTemplate: MinutesTemplateName = "週次定例";
const minutesWorkspaceDraftPrefix = "meet-jerky:minutes-workspace:";

const externalAiMinutesProviders = new Set<AiMinutesProvider>([
  "anthropic",
  "openAI",
]);

interface MinutesTemplateSpec {
  goal: string;
  sections: ReadonlyArray<string>;
  promptHint: string;
}

const minutesTemplateSpecs: Record<MinutesTemplateName, MinutesTemplateSpec> = {
  週次定例: {
    goal: "進捗・論点・決定事項・次アクションを短く整理",
    sections: ["要点", "決定事項", "未解決の論点", "タスク"],
    promptHint: "定例会議として重複発言を圧縮し、次回確認事項を残す",
  },
  "1on1": {
    goal: "相手の状態、相談事項、合意した支援を中心に整理",
    sections: ["コンディション", "相談内容", "合意事項", "フォローアップ"],
    promptHint: "評価ではなく対話記録として、本人の言葉と支援内容を分ける",
  },
  採用面接: {
    goal: "候補者の経験・強み・懸念点・次ステップを分離",
    sections: ["候補者サマリー", "評価ポイント", "確認した懸念", "次ステップ"],
    promptHint: "断定を避け、発言ベースの根拠と面接官メモを区別する",
  },
  顧客定例: {
    goal: "顧客要望、課題、約束事項、リスクを営業/CS向けに整理",
    sections: ["顧客状況", "要望・課題", "約束事項", "リスク"],
    promptHint: "顧客発言と自社側の対応方針を分け、期限がある項目を優先する",
  },
};

interface MinutesWorkspaceDraft {
  minutesTemplate: MinutesTemplateName;
  handwrittenMemo: string;
  templateInstruction: string;
  generatedMinutesDraft: string;
  savedAt: string;
}

function isMinutesTemplateName(value: unknown): value is MinutesTemplateName {
  return (
    typeof value === "string" &&
    minutesTemplateOptions.includes(value as MinutesTemplateName)
  );
}

function getMinutesWorkspaceDraftKey(sessionPath: string): string {
  return `${minutesWorkspaceDraftPrefix}${encodeURIComponent(sessionPath)}`;
}

function readMinutesWorkspaceDraft(
  sessionPath: string,
): MinutesWorkspaceDraft | null {
  try {
    const rawDraft = window.localStorage.getItem(
      getMinutesWorkspaceDraftKey(sessionPath),
    );
    if (!rawDraft) {
      return null;
    }
    const parsedDraft = JSON.parse(rawDraft) as Partial<MinutesWorkspaceDraft>;
    if (!isMinutesTemplateName(parsedDraft.minutesTemplate)) {
      return null;
    }
    return {
      minutesTemplate: parsedDraft.minutesTemplate,
      handwrittenMemo:
        typeof parsedDraft.handwrittenMemo === "string"
          ? parsedDraft.handwrittenMemo
          : "",
      templateInstruction:
        typeof parsedDraft.templateInstruction === "string"
          ? parsedDraft.templateInstruction
          : "",
      generatedMinutesDraft:
        typeof parsedDraft.generatedMinutesDraft === "string"
          ? parsedDraft.generatedMinutesDraft
          : "",
      savedAt:
        typeof parsedDraft.savedAt === "string"
          ? parsedDraft.savedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeMinutesWorkspaceDraft(
  sessionPath: string,
  draft: MinutesWorkspaceDraft,
): void {
  window.localStorage.setItem(
    getMinutesWorkspaceDraftKey(sessionPath),
    JSON.stringify(draft),
  );
}

function clearMinutesWorkspaceDraft(sessionPath: string): void {
  window.localStorage.removeItem(getMinutesWorkspaceDraftKey(sessionPath));
}

function formatDraftSavedAt(savedAt: string | null): string | null {
  if (!savedAt) {
    return null;
  }
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getAiMinutesProviderDisplayName(provider: AiMinutesProvider): string {
  if (provider === "anthropic") {
    return "Anthropic";
  }
  if (provider === "openAI") {
    return "OpenAI";
  }
  if (provider === "ollama") {
    return "Ollama";
  }
  return "オフ";
}

function buildMinutesPrompt({
  title,
  templateName,
  templateSpec,
  parsed,
  handwrittenMemo,
  templateInstruction,
}: {
  title: string;
  templateName: MinutesTemplateName;
  templateSpec: MinutesTemplateSpec;
  parsed: ReturnType<typeof parseSessionMarkdown> | null;
  handwrittenMemo: string;
  templateInstruction: string;
}): string {
  const transcriptLines =
    parsed?.segments.map(
      (segment) => `[${segment.time}] ${segment.speaker}: ${segment.text}`,
    ) ?? [];
  const notes = parsed?.notes ?? [];
  const trimmedMemo = handwrittenMemo.trim();
  const trimmedInstruction = templateInstruction.trim();
  return [
    `# ${title} の議事録を作成してください`,
    "",
    "## 目的",
    templateSpec.goal,
    "",
    "## 出力セクション",
    ...templateSpec.sections.map((section) => `- ${section}`),
    "",
    "## 方針",
    templateSpec.promptHint,
    "",
    "## この録音だけの補足指示",
    trimmedInstruction || "補足指示未入力",
    "",
    "## 議事録テンプレート",
    templateName,
    "",
    "## 追加メモ",
    trimmedMemo || "手書きメモ未入力",
    "",
    "## 保存済みノート",
    notes.length > 0 ? notes.join("\n") : "保存済みノートなし",
    "",
    "## 文字起こし",
    transcriptLines.length > 0 ? transcriptLines.join("\n") : "文字起こしなし",
    "",
    "## 制約",
    "- 発言にない事実は追加しない",
    "- 決定事項とタスクは根拠になる発言が分かるように簡潔に書く",
    "- 手書きメモは補助情報として扱い、文字起こしと矛盾する場合は矛盾点を明記する",
  ].join("\n");
}

function getTranscriptLinesForDraft(
  parsed: ReturnType<typeof parseSessionMarkdown> | null,
): string[] {
  return (
    parsed?.segments.map(
      (segment) => `[${segment.time}] ${segment.speaker}: ${segment.text}`,
    ) ?? []
  );
}

function getMemoLinesForDraft(handwrittenMemo: string): string[] {
  return handwrittenMemo
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getDraftSectionLines({
  section,
  transcriptLines,
  memoLines,
}: {
  section: string;
  transcriptLines: ReadonlyArray<string>;
  memoLines: ReadonlyArray<string>;
}): string[] {
  if (
    section.includes("ToDo") ||
    section.includes("フォローアップ") ||
    section.includes("次")
  ) {
    const candidates = [...memoLines, ...transcriptLines].filter((line) =>
      /(対応|次|確認|期限|TODO|ToDo|タスク|導入|レビュー|フォロー)/i.test(line),
    );
    return candidates.slice(0, 5);
  }
  if (
    section.includes("決定") ||
    section.includes("合意") ||
    section.includes("約束")
  ) {
    const candidates = [...memoLines, ...transcriptLines].filter((line) =>
      /(決定|合意|約束|する|します|方針|採用|導入|開始)/.test(line),
    );
    return candidates.slice(0, 5);
  }
  if (
    section.includes("懸念") ||
    section.includes("論点") ||
    section.includes("リスク") ||
    section.includes("課題")
  ) {
    const candidates = [...memoLines, ...transcriptLines].filter((line) =>
      /(懸念|課題|リスク|未解決|確認|問題|レビュー|セキュリティ)/.test(line),
    );
    return candidates.slice(0, 5);
  }
  return [...memoLines, ...transcriptLines].slice(0, 5);
}

function buildLocalMinutesDraft({
  title,
  templateName,
  templateSpec,
  parsed,
  handwrittenMemo,
  templateInstruction,
}: {
  title: string;
  templateName: MinutesTemplateName;
  templateSpec: MinutesTemplateSpec;
  parsed: ReturnType<typeof parseSessionMarkdown> | null;
  handwrittenMemo: string;
  templateInstruction: string;
}): string {
  const transcriptLines = getTranscriptLinesForDraft(parsed);
  const memoLines = getMemoLinesForDraft(handwrittenMemo);
  const trimmedInstruction = templateInstruction.trim();
  const sourceSummary = [
    `議事録テンプレート: ${templateName}`,
    `文字起こし: ${transcriptLines.length} 件`,
    `手書きメモ: ${
      memoLines.length > 0 ? `${memoLines.length} 件` : "メモ未入力"
    }`,
    `補足指示: ${trimmedInstruction ? "指示入力あり" : "指示未入力"}`,
    "生成方式: 端末内下書き（AI外部送信なし）",
  ];
  const sections = templateSpec.sections.flatMap((section) => {
    const lines = getDraftSectionLines({ section, transcriptLines, memoLines });
    return [
      `## ${section}`,
      ...(lines.length > 0
        ? lines.map((line) => `- ${line}`)
        : ["- 該当する記録はまだ抽出できません。"]),
      "",
    ];
  });

  return [
    `# ${title} 議事録下書き`,
    "",
    "## 元データ",
    ...sourceSummary.map((line) => `- ${line}`),
    "",
    "## 方針",
    `- ${templateSpec.goal}`,
    `- ${templateSpec.promptHint}`,
    ...(trimmedInstruction
      ? ["", "## この録音だけの補足指示", `- ${trimmedInstruction}`]
      : []),
    "",
    ...sections,
    "## 確認メモ",
    "- この下書きは文字列抽出による端末内生成です。最終議事録として使う前に内容を確認してください。",
    "- 音声トラックは含めていません。",
  ].join("\n");
}

function formatTrackTranscript(
  trackLabel: string,
  segments: ReadonlyArray<{ time: string; speaker: string; text: string }>,
): string {
  return [
    `# ${trackLabel} の文字起こし`,
    "",
    ...segments.map(
      (segment) => `[${segment.time}] ${segment.speaker}: ${segment.text}`,
    ),
  ].join("\n");
}

function getSelectedAudioAsset(
  playbackTrack: PlaybackTrack,
  audioAssets: ReturnType<typeof useSessionAudioAssets>["data"] | undefined,
): SessionAudioAsset | null {
  if (!audioAssets) {
    return null;
  }
  if (playbackTrack === "self") {
    return audioAssets.microphone;
  }
  if (playbackTrack === "other") {
    return audioAssets.speaker;
  }
  return audioAssets.mix;
}

/**
 * 保存済みセッションを v2 の履歴/議事録ワークスペースとして提示する。
 * アプリからAI議事録を外部送信せず、音声は保存済みトラックが存在する場合だけ再生する。
 */
export function SessionDetail() {
  const { encodedPath } = useParams({ from: "/sessions/$encodedPath" });
  const sessionPath = useMemo(() => {
    try {
      return decodeURIComponent(encodedPath);
    } catch (e) {
      console.error(
        "セッションパスのデコードに失敗しました:",
        toErrorMessage(e),
      );
      return encodedPath;
    }
  }, [encodedPath]);
  const sessionList = useSessionList();
  const sessionContent = useSessionContent(sessionPath);
  const sessionAudioAssets = useSessionAudioAssets(sessionPath);
  const settings = useQuery<AppSettings>({
    queryKey: ["app-settings"],
    queryFn: () =>
      isTauriRuntime()
        ? invoke<AppSettings>("get_settings")
        : Promise.resolve(PREVIEW_APP_SETTINGS),
  });
  const summary = sessionList.data?.find((s) => s.path === sessionPath) ?? null;
  const parsed = useMemo(() => {
    if (!sessionContent.data?.body) {
      return null;
    }
    return parseSessionMarkdown(sessionContent.data.body);
  }, [sessionContent.data?.body]);
  const [playbackTrack, setPlaybackTrack] = useState<PlaybackTrack>("both");
  const [minutesTemplate, setMinutesTemplate] = useState<MinutesTemplateName>(
    defaultMinutesTemplate,
  );
  const [handwrittenMemo, setHandwrittenMemo] = useState("");
  const [templateInstruction, setTemplateInstruction] = useState("");
  const [isTemplateInstructionOpen, setIsTemplateInstructionOpen] =
    useState(false);
  const [generatedMinutesDraft, setGeneratedMinutesDraft] = useState("");
  const [isDraftHydrated, setIsDraftHydrated] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState("");
  const transcriptSearchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setIsDraftHydrated(false);
    const draft = readMinutesWorkspaceDraft(sessionPath);
    setMinutesTemplate(draft?.minutesTemplate ?? defaultMinutesTemplate);
    setHandwrittenMemo(draft?.handwrittenMemo ?? "");
    setTemplateInstruction(draft?.templateInstruction ?? "");
    setIsTemplateInstructionOpen(Boolean(draft?.templateInstruction?.trim()));
    setGeneratedMinutesDraft(draft?.generatedMinutesDraft ?? "");
    setDraftSavedAt(draft?.savedAt ?? null);
    setDraftError(null);
    setIsDraftHydrated(true);
  }, [sessionPath]);

  useEffect(() => {
    if (!isDraftHydrated) {
      return;
    }
    const trimmedMemo = handwrittenMemo.trim();
    const trimmedTemplateInstruction = templateInstruction.trim();
    const canClearDraft =
      minutesTemplate === defaultMinutesTemplate &&
      trimmedMemo.length === 0 &&
      trimmedTemplateInstruction.length === 0 &&
      generatedMinutesDraft.trim().length === 0;
    try {
      if (canClearDraft) {
        clearMinutesWorkspaceDraft(sessionPath);
        setDraftSavedAt(null);
        setDraftError(null);
        return;
      }
      const savedAt = new Date().toISOString();
      writeMinutesWorkspaceDraft(sessionPath, {
        minutesTemplate,
        handwrittenMemo,
        templateInstruction,
        generatedMinutesDraft,
        savedAt,
      });
      setDraftSavedAt(savedAt);
      setDraftError(null);
    } catch (e) {
      console.error("議事録下書きを保存できませんでした:", toErrorMessage(e));
      setDraftError("議事録下書きを保存できませんでした");
    }
  }, [
    generatedMinutesDraft,
    handwrittenMemo,
    isDraftHydrated,
    minutesTemplate,
    sessionPath,
    templateInstruction,
  ]);

  const handleCopySession = useCallback(async () => {
    setActionError(null);
    setCopyStatus(null);
    const body = sessionContent.data?.body;
    if (!body) {
      setActionError("コピーできる文字起こしがありません。");
      return;
    }
    try {
      await writeClipboardText(body);
      setCopyStatus("文字起こしをコピーしました");
    } catch (e) {
      console.error("文字起こしをコピーできませんでした:", toErrorMessage(e));
      setActionError("文字起こしをコピーできませんでした");
    }
  }, [sessionContent.data?.body]);

  const hasSessionBody = Boolean(sessionContent.data?.body);
  const fileName = getFileName(sessionPath);
  const displayTitle = summary
    ? getCompactSessionTitle(summary.title)
    : (parsed?.titleLine ?? fileName);
  const startedAtDisplay = summary
    ? getSessionStartedAtDisplay(summary.startedAtSecs)
    : null;
  const isLoading = sessionContent.isLoading || sessionList.isLoading;
  const loadError = sessionContent.error ?? null;
  const transcriptTrackCounts = useMemo(() => {
    const counts = { self: 0, other: 0, unknown: 0 };
    for (const segment of parsed?.segments ?? []) {
      if (segment.speaker === "自分") {
        counts.self += 1;
      } else if (segment.speaker === "相手側") {
        counts.other += 1;
      } else {
        counts.unknown += 1;
      }
    }
    return counts;
  }, [parsed?.segments]);
  const getTrackTranscriptCount = (track: PlaybackTrack) => {
    if (track === "both") {
      return transcriptTrackCounts.self + transcriptTrackCounts.other;
    }
    return track === "self"
      ? transcriptTrackCounts.self
      : transcriptTrackCounts.other;
  };
  const trackTabs: ReadonlyArray<{
    key: PlaybackTrack;
    label: string;
    count: number;
    state: string;
    ariaLabel: string;
  }> = ([
    { key: "both", label: "マイク + スピーカー" },
    { key: "self", label: "マイクのみ" },
    { key: "other", label: "スピーカーのみ" },
  ] as const).map((tab) => {
    const count = getTrackTranscriptCount(tab.key);
    const audioAsset = getSelectedAudioAsset(tab.key, sessionAudioAssets.data);
    const state = sessionAudioAssets.isLoading
      ? "音声確認中"
      : sessionAudioAssets.error
        ? "音声確認失敗"
        : audioAsset?.exists
          ? "音声トラックあり"
          : count > 0
            ? "文字起こしのみ"
            : "音声トラック未保存";
    return {
      ...tab,
      count,
      state,
      ariaLabel: `${tab.label}: ${state}、文字起こし ${count} 件`,
    };
  });
  const selectedTemplateSpec = minutesTemplateSpecs[minutesTemplate];
  const selectedTemplateSectionsLabel =
    selectedTemplateSpec.sections.join(" / ");
  const trimmedHandwrittenMemo = handwrittenMemo.trim();
  const hasHandwrittenMemo = trimmedHandwrittenMemo.length > 0;
  const handwrittenMemoLineCount = hasHandwrittenMemo
    ? trimmedHandwrittenMemo.split(/\r?\n/).filter((line) => line.trim()).length
    : 0;
  const handwrittenMemoSummary = hasHandwrittenMemo
    ? `${trimmedHandwrittenMemo.length} 字 / ${handwrittenMemoLineCount} 行`
    : "メモ未入力";
  const hasMinutesWorkspaceDraft =
    hasHandwrittenMemo ||
    minutesTemplate !== defaultMinutesTemplate ||
    templateInstruction.trim().length > 0 ||
    generatedMinutesDraft.trim().length > 0;
  const draftSavedAtLabel = formatDraftSavedAt(draftSavedAt);
  const transcriptSegmentCount =
    transcriptTrackCounts.self +
    transcriptTrackCounts.other +
    transcriptTrackCounts.unknown;
  const templateInstructionSummary = templateInstruction.trim()
    ? "補足指示入力あり"
    : "補足指示未入力";
  const templateInstructionInputLabel = `この録音だけの補足指示。${minutesTemplate}テンプレートの議事録生成に反映し、音声トラックは含めません。`;
  const normalizedTranscriptSearchQuery = transcriptSearchQuery
    .trim()
    .toLocaleLowerCase("ja-JP");
  const filteredTranscriptSegmentCount = useMemo(() => {
    if (!normalizedTranscriptSearchQuery) {
      return transcriptSegmentCount;
    }
    return (parsed?.segments ?? []).filter((segment) =>
      [segment.time, segment.speaker, segment.text]
        .join(" ")
        .toLocaleLowerCase("ja-JP")
        .includes(normalizedTranscriptSearchQuery),
    ).length;
  }, [
    normalizedTranscriptSearchQuery,
    parsed?.segments,
    transcriptSegmentCount,
  ]);
  const transcriptSearchStatusLabel = normalizedTranscriptSearchQuery
    ? `${filteredTranscriptSegmentCount} / ${transcriptSegmentCount} 件`
    : `${transcriptSegmentCount} 件`;
  const transcriptCopyActionLabel = [
    `文字起こし全文をコピー: ${displayTitle}`,
    normalizedTranscriptSearchQuery
      ? `検索中 ${transcriptSearchStatusLabel}。コピー対象は検索結果ではなく全文です`
      : `全文 ${transcriptSegmentCount} 件をコピー`,
    "音声トラックはコピーしません",
  ].join("。");
  const selectedTrackLabel =
    playbackTrack === "both"
      ? "マイク + スピーカー"
      : playbackTrack === "self"
        ? "マイク"
        : "スピーカー";
  const selectedAudioAsset = getSelectedAudioAsset(
    playbackTrack,
    sessionAudioAssets.data,
  );
  const canPlaySelectedAudio = Boolean(selectedAudioAsset?.exists);
  const selectedAudioSrc =
    canPlaySelectedAudio && selectedAudioAsset
      ? convertFileSrc(selectedAudioAsset.path)
      : null;
  const audioAssetStatusLabel = sessionAudioAssets.isLoading
    ? "音声確認中"
    : sessionAudioAssets.error
      ? "音声確認失敗"
      : canPlaySelectedAudio
        ? "アプリ内再生可"
        : "音声トラック未保存";
  const audioAssetStatusDetail = sessionAudioAssets.error
    ? "音声トラックを確認できませんでした"
    : selectedAudioAsset?.exists
      ? `${selectedTrackLabel} の音声トラックをアプリ内で再生できます`
      : playbackTrack === "both"
        ? "マイクとスピーカーの音声トラックは未保存です"
        : `${selectedTrackLabel} の音声トラックは未保存です`;
  const playbackTrackTabsLabel = [
    "音声再生対象の切り替え",
    `選択中 ${selectedTrackLabel}`,
    "マイクのみ、スピーカーのみ、両方を選択可能",
  ].join("。");
  const playbackModeFlow = [
    {
      label: "両方",
      value: trackTabs[0]?.state ?? "確認中",
      detail: `${trackTabs[0]?.count ?? 0} 発話`,
      tone: sessionAudioAssets.data?.mix?.exists ? "accent" : "muted",
    },
    {
      label: "マイク",
      value: trackTabs[1]?.state ?? "確認中",
      detail: `${transcriptTrackCounts.self} 発話`,
      tone: sessionAudioAssets.data?.microphone?.exists ? "safe" : "muted",
    },
    {
      label: "スピーカー",
      value: trackTabs[2]?.state ?? "確認中",
      detail: `${transcriptTrackCounts.other} 発話`,
      tone: sessionAudioAssets.data?.speaker?.exists ? "warn" : "muted",
    },
    {
      label: "送信",
      value: "外部送信なし",
      detail: "再生のみ",
      tone: "safe",
    },
  ] as const;
  const playbackModeFlowLabel = [
    "音声トラック再生モード",
    `両方 ${trackTabs[0]?.state ?? "確認中"}`,
    `マイクのみ ${trackTabs[1]?.state ?? "確認中"}`,
    `スピーカーのみ ${trackTabs[2]?.state ?? "確認中"}`,
    "音声トラックはAI外部送信せず再生と外部アプリ起動だけに使います",
  ].join("。");
  const shouldShowAudioAssetNote =
    !selectedAudioSrc && (sessionAudioAssets.error || !canPlaySelectedAudio);
  const audioAssetNoteLabel = sessionAudioAssets.error
    ? "音声ファイルの存在確認に失敗しました。文字起こしと議事録作成は利用できます。"
    : "この音声トラックは保存されていません。文字起こしは下のチャット表示から確認できます。";
  const aiMinutesProvider = settings.data?.aiMinutesProvider ?? "none";
  const isExternalAiMinutesProvider =
    externalAiMinutesProviders.has(aiMinutesProvider);
  const isLocalAiMinutesProvider = aiMinutesProvider === "ollama";
  const aiMinutesConnectionLabel = settings.isLoading
    ? "議事録設定確認中"
    : settings.error
      ? "議事録設定確認失敗"
      : aiMinutesProvider === "none"
        ? "AIオフ"
        : isLocalAiMinutesProvider
          ? "端末内AI"
          : "手動コピー確認";
  const aiMinutesTransmissionLabel = settings.error
    ? "議事録設定を確認できませんでした"
    : isExternalAiMinutesProvider
      ? "AI外部送信は手動コピー時に確認"
      : isLocalAiMinutesProvider
        ? "端末内・AI外部送信なし"
        : "AI議事録オフ・AI外部送信なし";
  const aiMinutesSourceScopeLabel = settings.isLoading
    ? "AI設定確認中"
    : settings.error
      ? "AI設定未確認"
      : `AI ${getAiMinutesProviderDisplayName(aiMinutesProvider)} / ${aiMinutesConnectionLabel}`;
  const aiMinutesConnectionClassName = [
    "session-detail-local-minutes-status",
    settings.error ? "session-detail-local-minutes-status-error" : "",
    isExternalAiMinutesProvider
      ? "session-detail-local-minutes-status-external"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const aiMinutesActionDetail = isExternalAiMinutesProvider
    ? "外部AIへ送る場合は、文字起こしと手書きメモのプロンプトを手動コピーします。音声トラックは含めません。"
    : isLocalAiMinutesProvider
      ? "Ollama設定です。音声トラックを送らず、文字起こしと手書きメモからこのMac内で下書きを作成します。"
      : "AI議事録はオフです。文字起こしと手書きメモから、このMac内で下書きを作成します。";
  const minutesFlowReviewLabel = isExternalAiMinutesProvider
    ? "送信用プロンプト"
    : "端末内議事録下書き";
  const handwrittenMemoInputLabel = [
    "手書きメモ入力",
    `この録音の議事録ワークスペースに保存`,
    `文字起こし ${transcriptSegmentCount} 件と合わせて${minutesFlowReviewLabel}に反映`,
    `テンプレート ${minutesTemplate}`,
    aiMinutesTransmissionLabel,
    "音声トラックは含めません",
    `現在 ${handwrittenMemoSummary}`,
  ].join("。");
  const handwrittenMemoClearLabel = [
    "手書きメモをクリア",
    "この録音の議事録ワークスペースから補助メモを外します",
    `文字起こし ${transcriptSegmentCount} 件と音声トラックは残します`,
  ].join("。");
  const handwrittenMemoMaterialFlow = [
    {
      label: "保存",
      value: hasHandwrittenMemo ? "この録音" : "未入力",
      tone: hasHandwrittenMemo ? "safe" : "muted",
    },
    {
      label: "素材",
      value: hasHandwrittenMemo ? `${handwrittenMemoLineCount}行` : "任意",
      tone: hasHandwrittenMemo ? "accent" : "muted",
    },
    {
      label: "反映",
      value: minutesFlowReviewLabel,
      tone: isExternalAiMinutesProvider ? "warn" : "safe",
    },
    {
      label: "除外",
      value: "音声トラック",
      tone: "safe",
    },
  ] as const;
  const handwrittenMemoMaterialFlowLabel = [
    "手書きメモの扱い",
    hasHandwrittenMemo
      ? `この録音の議事録ワークスペースに ${handwrittenMemoLineCount} 行の手書きメモを保存`
      : "手書きメモは任意入力",
    `文字起こし ${transcriptSegmentCount} 件と合わせて${minutesFlowReviewLabel}へ反映`,
    aiMinutesTransmissionLabel,
    "音声トラックは含めません",
  ].join("。");
  const minutesPromptActionLabel = isExternalAiMinutesProvider
    ? "AI議事録プロンプトコピー"
    : "議事録プロンプトコピー";
  const minutesDraftCardHeading = isExternalAiMinutesProvider
    ? "AI議事録プロンプト"
    : "端末内議事録下書き";
  const minutesWorkspaceArtifactLabel = isExternalAiMinutesProvider
    ? "AI議事録プロンプト"
    : "議事録下書き";
  const minutesDraftStatusLabel = draftError
    ? `${minutesWorkspaceArtifactLabel}保存エラー`
    : hasMinutesWorkspaceDraft && draftSavedAtLabel
      ? `${minutesWorkspaceArtifactLabel}保存 ${draftSavedAtLabel}`
      : hasMinutesWorkspaceDraft
        ? `${minutesWorkspaceArtifactLabel}保存済み`
        : `${minutesWorkspaceArtifactLabel}なし`;
  const minutesDraftActionLabel = isExternalAiMinutesProvider
    ? "文字起こし+手書きメモでプロンプト作成"
    : "文字起こし+手書きメモで下書き";
  const minutesDraftEmptyLabel = isExternalAiMinutesProvider
    ? "文字起こしと手書きメモから作る送信用プロンプトがここに表示されます"
    : "文字起こしと手書きメモから作る議事録下書きがここに表示されます";
  const minutesDraftCardAriaLabel = [
    minutesDraftCardHeading,
    minutesTemplate,
    aiMinutesTransmissionLabel,
    "音声トラック外部送信なし",
  ].join("。");
  const minutesPanelLabel = [
    "議事録ワークスペース",
    `文字起こし ${transcriptSegmentCount} 件`,
    `テンプレート ${minutesTemplate}`,
    `手書きメモ ${handwrittenMemoSummary}`,
    aiMinutesTransmissionLabel,
    "音声トラック外部送信なし",
  ].join("。");
  const minutesFlowAriaLabel = [
    `文字起こし ${transcriptSegmentCount} 件`,
    `テンプレート ${minutesTemplate}`,
    `手書きメモ ${handwrittenMemoSummary}`,
    `生成 ${minutesFlowReviewLabel}`,
    aiMinutesTransmissionLabel,
  ].join("、");
  const minutesInputBoundaryFlow = [
    {
      label: "入力",
      value: `${transcriptSegmentCount}発話 + ${hasHandwrittenMemo ? "手書きメモ" : "メモ任意"}`,
      tone: transcriptSegmentCount > 0 ? "accent" : "muted",
    },
    {
      label: "出力",
      value: minutesFlowReviewLabel,
      tone: isExternalAiMinutesProvider ? "warn" : "safe",
    },
    {
      label: "除外",
      value: "音声トラック",
      tone: "safe",
    },
  ] as const;
  const minutesInputBoundaryFlowLabel = [
    "議事録生成の入力と境界",
    `入力は文字起こし ${transcriptSegmentCount} 発話と${hasHandwrittenMemo ? "手書きメモ" : "任意の手書きメモ"}`,
    `出力は${minutesFlowReviewLabel}`,
    aiMinutesTransmissionLabel,
    "音声トラックは含めません",
  ].join("。");
  const minutesTemplateSelectionLabel = [
    `議事録テンプレート選択: ${minutesTemplate}`,
    selectedTemplateSpec.goal,
    `出力セクション ${selectedTemplateSectionsLabel}`,
    `文字起こし ${transcriptSegmentCount} 件`,
    `手書きメモ ${handwrittenMemoSummary}`,
    "音声トラックは送信しません",
  ].join("。");
  const transcriptReviewFlow = [
    {
      label: "表示",
      value: "チャット",
      detail: `自分 ${transcriptTrackCounts.self} / 相手側 ${transcriptTrackCounts.other}`,
      tone: transcriptSegmentCount > 0 ? "accent" : "muted",
    },
    {
      label: "検索",
      value: transcriptSearchStatusLabel,
      detail: normalizedTranscriptSearchQuery ? "絞り込み中" : "全文対象",
      tone: normalizedTranscriptSearchQuery ? "warn" : "neutral",
    },
    {
      label: "コピー",
      value: transcriptSegmentCount > 0 ? "全文可" : "なし",
      detail: "音声は含めない",
      tone: transcriptSegmentCount > 0 ? "safe" : "muted",
    },
    {
      label: "議事録",
      value: minutesFlowReviewLabel,
      detail: "素材として使用",
      tone: isExternalAiMinutesProvider ? "warn" : "safe",
    },
  ] as const;
  const transcriptReviewFlowLabel = [
    "チャット文字起こしの状態",
    `表示は自分が右、相手側が左`,
    `文字起こし ${transcriptSearchStatusLabel}`,
    normalizedTranscriptSearchQuery
      ? "検索結果を表示中。コピー対象は全文です"
      : "検索なし。全文を表示中",
    `議事録では${minutesFlowReviewLabel}の素材として使います`,
    "音声トラックはコピーや議事録に含めません",
  ].join("。");
  const sessionReviewRail = [
    {
      label: "音声トラック",
      value: selectedTrackLabel,
      detail: `${audioAssetStatusLabel} / ${trackTabs.length}モード`,
      tone: canPlaySelectedAudio ? "ready" : "muted",
    },
    {
      label: "文字起こし",
      value: `${transcriptSearchStatusLabel}`,
      detail: "チャット表示 / 検索 / コピー",
      tone: transcriptSegmentCount > 0 ? "ready" : "muted",
    },
    {
      label: "議事録",
      value: minutesTemplate,
      detail: `${minutesFlowReviewLabel} / ${aiMinutesConnectionLabel}`,
      tone: isExternalAiMinutesProvider ? "warn" : "ready",
    },
    {
      label: "送信境界",
      value: isExternalAiMinutesProvider ? "手動コピー確認" : "外部送信なし",
      detail: "音声トラックは送信しません",
      tone: isExternalAiMinutesProvider ? "warn" : "safe",
    },
  ] as const;
  const sessionReviewRailLabel = sessionReviewRail
    .map((item) => `${item.label}: ${item.value}。${item.detail}`)
    .join("、");
  const sessionReviewActionFlow = [
    {
      label: "検索",
      value: transcriptSearchStatusLabel,
      detail: "チャット文字起こし",
      tone: "neutral",
    },
    {
      label: "コピー",
      value: transcriptSegmentCount > 0 ? "全文 / トラック" : "未取得",
      detail: "音声は含めない",
      tone: transcriptSegmentCount > 0 ? "accent" : "muted",
    },
    {
      label: "音声",
      value: selectedTrackLabel,
      detail: audioAssetStatusLabel,
      tone: canPlaySelectedAudio ? "safe" : "muted",
    },
    {
      label: "議事録",
      value: minutesFlowReviewLabel,
      detail: aiMinutesConnectionLabel,
      tone: isExternalAiMinutesProvider ? "warn" : "safe",
    },
  ] as const;
  const sessionReviewActionFlowLabel = [
    "録音後アクション",
    "検索、コピー、音声トラック確認、議事録生成をこの画面で行えます",
    "音声トラックはAI外部送信しません",
    ...sessionReviewActionFlow.map(
      (item) => `${item.label}: ${item.value}。${item.detail}`,
    ),
  ].join("。");
  const selectedTrackSegments = useMemo(() => {
    const segments = parsed?.segments ?? [];
    if (playbackTrack === "both") {
      return segments.filter(
        (segment) => segment.speaker === "自分" || segment.speaker === "相手側",
      );
    }
    const speaker = playbackTrack === "self" ? "自分" : "相手側";
    return segments.filter((segment) => segment.speaker === speaker);
  }, [parsed?.segments, playbackTrack]);
  const playbackActionLabel = `${selectedTrackLabel}の音声トラックを外部アプリで開く`;
  const selectedTrackCopyLabel = `${selectedTrackLabel}の文字起こしをコピー`;
  const handleCopyMinutesPrompt = useCallback(async () => {
    setActionError(null);
    setCopyStatus(null);
    const prompt = buildMinutesPrompt({
      title: displayTitle,
      templateName: minutesTemplate,
      templateSpec: selectedTemplateSpec,
      parsed,
      handwrittenMemo,
      templateInstruction,
    });
    const promptCopyTargetLabel = isExternalAiMinutesProvider
      ? "AI議事録プロンプト"
      : "議事録プロンプト";
    try {
      await writeClipboardText(prompt);
      setCopyStatus(`${promptCopyTargetLabel}をコピーしました`);
    } catch (e) {
      console.error(
        `${promptCopyTargetLabel}をコピーできませんでした:`,
        toErrorMessage(e),
      );
      setActionError(`${promptCopyTargetLabel}をコピーできませんでした`);
    }
  }, [
    displayTitle,
    handwrittenMemo,
    isExternalAiMinutesProvider,
    minutesTemplate,
    parsed,
    selectedTemplateSpec,
    templateInstruction,
  ]);
  const handleGenerateLocalMinutesDraft = useCallback(() => {
    setActionError(null);
    setCopyStatus(null);
    if (isExternalAiMinutesProvider) {
      const prompt = buildMinutesPrompt({
        title: displayTitle,
        templateName: minutesTemplate,
        templateSpec: selectedTemplateSpec,
        parsed,
        handwrittenMemo,
        templateInstruction,
      });
      setGeneratedMinutesDraft(prompt);
      setCopyStatus("AI議事録プロンプトを作成しました");
      return;
    }
    const draft = buildLocalMinutesDraft({
      title: displayTitle,
      templateName: minutesTemplate,
      templateSpec: selectedTemplateSpec,
      parsed,
      handwrittenMemo,
      templateInstruction,
    });
    setGeneratedMinutesDraft(draft);
    setCopyStatus("議事録下書きを作成しました");
  }, [
    displayTitle,
    handwrittenMemo,
    isExternalAiMinutesProvider,
    minutesTemplate,
    parsed,
    selectedTemplateSpec,
    templateInstruction,
  ]);
  const handleCopyGeneratedMinutesDraft = useCallback(async () => {
    setActionError(null);
    setCopyStatus(null);
    if (!generatedMinutesDraft.trim()) {
      setActionError(
        isExternalAiMinutesProvider
          ? "コピーできるAI議事録プロンプトがありません。"
          : "コピーできる議事録下書きがありません。",
      );
      return;
    }
    try {
      await writeClipboardText(generatedMinutesDraft);
      setCopyStatus(
        isExternalAiMinutesProvider
          ? "AI議事録プロンプトをコピーしました"
          : "議事録下書きをコピーしました",
      );
    } catch (e) {
      const copyErrorLabel = isExternalAiMinutesProvider
        ? "AI議事録プロンプトをコピーできませんでした"
        : "議事録下書きをコピーできませんでした";
      console.error(`${copyErrorLabel}:`, toErrorMessage(e));
      setActionError(copyErrorLabel);
    }
  }, [generatedMinutesDraft, isExternalAiMinutesProvider]);
  const handleCopySelectedTrackTranscript = useCallback(async () => {
    setActionError(null);
    setCopyStatus(null);
    if (selectedTrackSegments.length === 0) {
      setActionError(
        `${selectedTrackLabel} のコピーできる文字起こしがありません。`,
      );
      return;
    }
    try {
      await writeClipboardText(
        formatTrackTranscript(selectedTrackLabel, selectedTrackSegments),
      );
      setCopyStatus(`${selectedTrackLabel} の文字起こしをコピーしました`);
    } catch (e) {
      console.error(
        `${selectedTrackLabel} の文字起こしをコピーできませんでした:`,
        toErrorMessage(e),
      );
      setActionError(
        `${selectedTrackLabel} の文字起こしをコピーできませんでした`,
      );
    }
  }, [selectedTrackLabel, selectedTrackSegments]);
  const handleOpenSelectedAudio = useCallback(async () => {
    setActionError(null);
    setCopyStatus(null);
    if (!selectedAudioAsset?.exists) {
      if (sessionAudioAssets.error) {
        console.error(
          "音声トラックの状態を確認できませんでした:",
          toErrorMessage(sessionAudioAssets.error),
        );
      }
      setActionError(audioAssetStatusDetail);
      return;
    }
    try {
      await openPath(selectedAudioAsset.path);
      setCopyStatus(`${selectedTrackLabel} の音声トラックを開きました`);
    } catch (e) {
      console.error(
        `${selectedTrackLabel} の音声トラックを開けませんでした:`,
        toErrorMessage(e),
      );
      setActionError(`${selectedTrackLabel} の音声トラックを開けませんでした`);
    }
  }, [
    audioAssetStatusDetail,
    selectedAudioAsset?.exists,
    selectedAudioAsset?.path,
    selectedTrackLabel,
  ]);
  return (
    <div
      className="session-detail"
      aria-label={`録音詳細 ${displayTitle}`}
      title={`録音詳細 ${displayTitle}`}
    >
      <header className="session-detail-header">
        <Link
          to="/sessions"
          className="session-detail-back"
          aria-label="文字起こし履歴一覧へ戻る"
          title="文字起こし履歴一覧へ戻る"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          履歴一覧
        </Link>
        <h1 className="session-detail-title" title={displayTitle}>
          {displayTitle}
        </h1>
        {startedAtDisplay && (
          <p className="session-detail-meta">
            {startedAtDisplay.iso ? (
              <time dateTime={startedAtDisplay.iso}>
                {startedAtDisplay.label}
              </time>
            ) : (
              <span>{startedAtDisplay.label}</span>
            )}
          </p>
        )}
      </header>

      <section
        className="session-detail-review-rail"
        aria-label={`録音レビュー概要。${sessionReviewRailLabel}`}
        title={`録音レビュー概要。${sessionReviewRailLabel}`}
      >
        {sessionReviewRail.map((item) => (
          <div
            key={item.label}
            className={`session-detail-review-item session-detail-review-item-${item.tone}`}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
          </div>
        ))}
      </section>

      <section
        className="session-detail-action-flow"
        aria-label={sessionReviewActionFlowLabel}
        title={sessionReviewActionFlowLabel}
      >
        <span className="session-detail-action-flow-kicker">
          録音後アクション
        </span>
        <div className="session-detail-action-flow-steps">
          {sessionReviewActionFlow.map((item) => (
            <span
              key={`${item.label}-${item.value}`}
              className={`session-detail-action-flow-step session-detail-action-flow-step-${item.tone}`}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </span>
          ))}
        </div>
      </section>

      <section
        className="session-detail-track-card"
        aria-label={`音声トラック再生。マイク ${transcriptTrackCounts.self} 件、スピーカー ${transcriptTrackCounts.other} 件。マイクのみ、スピーカーのみ、両方を切り替えられます。`}
        title={`音声トラック再生: マイク ${transcriptTrackCounts.self} 件、スピーカー ${transcriptTrackCounts.other} 件`}
      >
	        <div className="session-detail-card-head">
	          <div>
	            <h2>音声トラック</h2>
	          </div>
          <div className="session-detail-track-head-actions">
            <span
              className={
                canPlaySelectedAudio
                  ? "session-detail-audio-status session-detail-audio-status-ready"
                  : "session-detail-audio-status"
              }
              aria-label={audioAssetStatusDetail}
              title={audioAssetStatusDetail}
            >
              音声トラック {audioAssetStatusLabel}
            </span>
            <div
              className="session-detail-track-tabs"
              role="group"
              aria-label={playbackTrackTabsLabel}
              title={playbackTrackTabsLabel}
            >
              {trackTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={
                    playbackTrack === tab.key
                      ? "session-detail-track-tab session-detail-track-tab-active"
                      : "session-detail-track-tab"
                  }
                  aria-pressed={playbackTrack === tab.key}
                  aria-label={tab.ariaLabel}
                  title={tab.ariaLabel}
                  onClick={() => setPlaybackTrack(tab.key)}
                >
                  <span>{tab.label}</span>
                  <small>{tab.state}</small>
                </button>
              ))}
	            </div>
	          </div>
	        </div>
	        <div
	          className="session-detail-playback-flow"
	          role="status"
	          aria-label={playbackModeFlowLabel}
	          title={playbackModeFlowLabel}
	        >
	          {playbackModeFlow.map((item) => (
	            <span
	              key={`${item.label}-${item.value}`}
	              className={`session-detail-playback-flow-chip session-detail-playback-flow-chip-${item.tone}`}
	            >
	              <span>{item.label}</span>
	              <strong>{item.value}</strong>
	              <small>{item.detail}</small>
	            </span>
	          ))}
	        </div>
	        {selectedAudioSrc && selectedAudioAsset ? (
	          <div
	            className="session-detail-audio-player"
            aria-label={`${selectedTrackLabel}の音声トラックを再生`}
            title={`${selectedTrackLabel}: ${getFileName(selectedAudioAsset.path)}`}
          >
            <audio
              key={selectedAudioAsset.path}
              controls
              preload="metadata"
              src={selectedAudioSrc}
            >
              音声を再生できません。
            </audio>
          </div>
        ) : null}
        {shouldShowAudioAssetNote ? (
          <p
            className={
              sessionAudioAssets.error
                ? "session-detail-audio-note session-detail-audio-note-error"
                : "session-detail-audio-note"
            }
            role={sessionAudioAssets.error ? "alert" : "status"}
            aria-label={audioAssetNoteLabel}
            title={audioAssetNoteLabel}
          >
            {audioAssetNoteLabel}
          </p>
        ) : null}
        <div className="session-detail-track-actions">
          {canPlaySelectedAudio ? (
            <button
              type="button"
              className="session-detail-play-button"
              aria-label={playbackActionLabel}
              title={playbackActionLabel}
              onClick={handleOpenSelectedAudio}
            >
              <ExternalLink size={14} aria-hidden="true" />
              音声を外部アプリで開く
            </button>
          ) : null}
          {selectedTrackSegments.length > 0 ? (
            <button
              type="button"
              className="session-detail-track-copy-button"
              onClick={handleCopySelectedTrackTranscript}
              aria-label={`${selectedTrackCopyLabel}。${selectedTrackSegments.length} 件`}
              title={`${selectedTrackCopyLabel}。${selectedTrackSegments.length} 件`}
            >
              <Clipboard size={14} aria-hidden="true" />
              トラック文字起こしコピー
            </button>
          ) : null}
        </div>
      </section>

      {actionError && (
        <div
          className="session-detail-error"
          role="alert"
          aria-label={`セッション操作エラー: ${actionError}`}
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => setActionError(null)}
            aria-label="セッション操作エラーを閉じる"
            title="セッション操作エラーを閉じる"
          >
            セッション操作エラーを閉じる
          </button>
        </div>
      )}
      {copyStatus && (
        <div
          className="session-detail-copy-status"
          role="status"
          aria-live="polite"
        >
          {copyStatus}
        </div>
      )}

      <section
        className="session-detail-workspace"
        aria-busy={isLoading}
        aria-label="録音詳細ワークスペース"
      >
        <section className="session-detail-transcript-panel">
          <div className="session-detail-panel-head">
            <h2>文字起こし</h2>
            {hasSessionBody ? (
              <button
                type="button"
                className="session-detail-panel-link"
                onClick={handleCopySession}
                aria-label={transcriptCopyActionLabel}
                title={transcriptCopyActionLabel}
              >
                文字起こしコピー
              </button>
            ) : null}
          </div>
          <div
            className="session-detail-transcript-flow"
            role="status"
            aria-label={transcriptReviewFlowLabel}
            title={transcriptReviewFlowLabel}
          >
            {transcriptReviewFlow.map((item) => (
              <span
                key={`${item.label}-${item.value}`}
                className={`session-detail-transcript-flow-chip session-detail-transcript-flow-chip-${item.tone}`}
              >
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </span>
            ))}
          </div>
          <div
            className={`session-detail-transcript-search${
              transcriptSearchQuery
                ? " session-detail-transcript-search-with-clear"
                : ""
            }`}
            role="search"
            aria-label={`検索: ${transcriptSearchStatusLabel}`}
          >
            <Search size={13} aria-hidden="true" />
            <input
              ref={transcriptSearchInputRef}
              type="search"
              value={transcriptSearchQuery}
              onChange={(event) => setTranscriptSearchQuery(event.target.value)}
              placeholder="文字起こし・話者・時刻を検索"
              aria-label="文字起こし、話者、時刻を検索"
            />
            <span role="status" aria-live="polite">
              {transcriptSearchStatusLabel}
            </span>
            {transcriptSearchQuery ? (
              <button
                type="button"
                onClick={() => setTranscriptSearchQuery("")}
                aria-label="文字起こし検索をクリア"
                title="文字起こし検索をクリア"
              >
                文字起こし検索クリア
              </button>
            ) : null}
          </div>
          {isLoading && (
            <p
              className="session-detail-loading"
              role="status"
              aria-live="polite"
            >
              録音レビュー読み込み中…
            </p>
          )}
          {!isLoading && loadError && (
            <p className="session-detail-error" role="alert">
              文字起こしを取得できませんでした
            </p>
          )}
          {!isLoading && !loadError && (
            <TranscriptTimeline
              parsed={parsed}
              searchQuery={normalizedTranscriptSearchQuery}
            />
          )}
        </section>

        <section
          className="session-detail-minutes-panel"
          aria-label={minutesPanelLabel}
          title={minutesPanelLabel}
        >
          <div className="session-detail-panel-head">
            <div>
              <h2>議事録</h2>
              <p>
                テンプレート、文字起こし、手書きメモから作成。音声トラックは送信しません。
              </p>
            </div>
            <div className="session-detail-minutes-head-actions">
              {draftError || hasMinutesWorkspaceDraft ? (
                <span
                  className={
                    draftError
                      ? "session-detail-draft-status session-detail-draft-status-error"
                      : "session-detail-draft-status session-detail-draft-status-saved"
                  }
                  role="status"
                  aria-live="polite"
                  aria-label={draftError ?? minutesDraftStatusLabel}
                  title={draftError ?? minutesDraftStatusLabel}
                >
                  {minutesDraftStatusLabel}
                </span>
              ) : null}
              {transcriptSegmentCount > 0 ? (
                <button
                  type="button"
                  className="session-detail-panel-link"
                  onClick={handleCopyMinutesPrompt}
                  aria-label={`${minutesPromptActionLabel}。${minutesTemplate}。${aiMinutesTransmissionLabel}`}
                  title={`${minutesPromptActionLabel}。${minutesTemplate}。${aiMinutesTransmissionLabel}`}
                >
                  {minutesPromptActionLabel}
                </button>
              ) : null}
              <button
                type="button"
                className="session-detail-panel-link"
                aria-expanded={isTemplateInstructionOpen}
                aria-controls="session-detail-template-instruction"
                aria-label={
                  isTemplateInstructionOpen
                    ? "補足指示を閉じる"
                    : "補足指示を編集"
                }
                title={
                  isTemplateInstructionOpen
                    ? "補足指示を閉じる"
                    : "補足指示を編集"
                }
                onClick={() =>
                  setIsTemplateInstructionOpen((current) => !current)
                }
              >
                {isTemplateInstructionOpen ? "補足指示を閉じる" : "補足指示編集"}
              </button>
            </div>
          </div>
          {draftError && (
            <p className="session-detail-draft-error" role="alert">
              {draftError}
            </p>
          )}
          <div
            className="session-detail-source-row"
            aria-label={[
              `文字起こし ${transcriptSegmentCount} 件`,
              `テンプレート ${minutesTemplate}`,
              `手書きメモ ${handwrittenMemoSummary}`,
              templateInstructionSummary,
              aiMinutesSourceScopeLabel,
              "音声トラック外部送信なし",
            ].join("、")}
            title={[
              `文字起こし ${transcriptSegmentCount} 件`,
              `テンプレート ${minutesTemplate}`,
              `手書きメモ ${handwrittenMemoSummary}`,
              templateInstructionSummary,
              aiMinutesSourceScopeLabel,
              "音声トラック外部送信なし",
            ].join("、")}
          >
            <span>文字起こし {transcriptSegmentCount}</span>
            <span className="session-detail-source-template">
              テンプレート {minutesTemplate}
            </span>
            <span className="session-detail-source-memo">
              手書きメモ {handwrittenMemoSummary}
            </span>
            <span>{templateInstructionSummary}</span>
            <span
              className={
                isExternalAiMinutesProvider
                  ? "session-detail-source-ai session-detail-source-ai-external"
                  : "session-detail-source-ai"
              }
              aria-label={`${aiMinutesSourceScopeLabel}。${aiMinutesTransmissionLabel}`}
              title={`${aiMinutesSourceScopeLabel}。${aiMinutesTransmissionLabel}`}
            >
              {aiMinutesSourceScopeLabel}
            </span>
            <span>音声トラック外部送信なし</span>
          </div>
          <div
            className="session-detail-template-row"
            role="group"
            aria-label={minutesTemplateSelectionLabel}
            title={minutesTemplateSelectionLabel}
          >
            {minutesTemplateOptions.map((template) => (
              <button
                key={template}
                type="button"
                className={
                  minutesTemplate === template
                    ? "session-detail-template-chip session-detail-template-chip-active"
                    : "session-detail-template-chip"
                }
                aria-pressed={minutesTemplate === template}
                aria-label={`${template} テンプレートを選択`}
                title={minutesTemplateSpecs[template].goal}
                onClick={() => setMinutesTemplate(template)}
              >
                {template}
              </button>
            ))}
          </div>
          <div
            className="session-detail-template-summary"
            aria-label={minutesTemplateSelectionLabel}
            title={minutesTemplateSelectionLabel}
          >
            <strong>{selectedTemplateSpec.goal}</strong>
            <span>{selectedTemplateSectionsLabel}</span>
          </div>
          <div
            className="session-detail-minutes-flow"
            role="status"
            aria-label={minutesFlowAriaLabel}
            title={minutesFlowAriaLabel}
          >
            <span>
              <strong>1</strong>
              文字起こし
            </span>
            <span>
              <strong>2</strong>
              テンプレート
            </span>
            <span>
              <strong>3</strong>
              手書きメモ
            </span>
            <span>
              <strong>4</strong>
              {minutesFlowReviewLabel}
            </span>
          </div>
          <div
            className="session-detail-minutes-boundary-flow"
            role="status"
            aria-label={minutesInputBoundaryFlowLabel}
            title={minutesInputBoundaryFlowLabel}
          >
            {minutesInputBoundaryFlow.map((item) => (
              <span
                key={`${item.label}-${item.value}`}
                className={`session-detail-minutes-boundary-chip session-detail-minutes-boundary-chip-${item.tone}`}
              >
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
          {isTemplateInstructionOpen && (
            <div
              id="session-detail-template-instruction"
              className="session-detail-template-instruction-card"
              aria-label={templateInstructionInputLabel}
              title={templateInstructionInputLabel}
            >
              <div className="session-detail-template-instruction-head">
                <strong>補足指示</strong>
              </div>
              <label className="session-detail-template-instruction-field">
                <span>補足指示</span>
                <textarea
                  value={templateInstruction}
                  onChange={(event) =>
                    setTemplateInstruction(event.target.value)
                  }
                  placeholder="例: 決定事項は期限と担当者を分ける"
                  aria-label={templateInstructionInputLabel}
                  title={templateInstructionInputLabel}
                />
              </label>
              <div className="session-detail-template-instruction-actions">
                <span>
                  {templateInstruction.trim() ? "指示反映中" : "指示未入力"}
                </span>
                {templateInstruction.trim() ? (
                  <button
                    type="button"
                    className="session-detail-template-instruction-clear"
                    onClick={() => setTemplateInstruction("")}
                    aria-label="補足指示をクリア"
                    title="補足指示をクリア"
                  >
                    補足指示クリア
                  </button>
                ) : null}
              </div>
            </div>
          )}
          <div className="session-detail-handwritten-card">
            <div className="session-detail-handwritten-head">
              <strong>手書きメモ</strong>
              {hasHandwrittenMemo ? (
                <span
                  className="session-detail-handwritten-status session-detail-handwritten-status-ready"
                  role="status"
                  aria-label={handwrittenMemoInputLabel}
                  title={handwrittenMemoInputLabel}
                >
                  メモ入力あり
                </span>
              ) : null}
            </div>
            <label className="session-detail-handwritten-field">
              <textarea
                value={handwrittenMemo}
                onChange={(event) => setHandwrittenMemo(event.target.value)}
                placeholder="例: β導入希望。懸念はセキュリティ。"
                aria-label={handwrittenMemoInputLabel}
                title={handwrittenMemoInputLabel}
              />
            </label>
            <div
              className="session-detail-handwritten-flow"
              role="status"
              aria-label={handwrittenMemoMaterialFlowLabel}
              title={handwrittenMemoMaterialFlowLabel}
            >
              {handwrittenMemoMaterialFlow.map((item) => (
                <span
                  key={`${item.label}-${item.value}`}
                  className={`session-detail-handwritten-flow-chip session-detail-handwritten-flow-chip-${item.tone}`}
                >
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </span>
              ))}
            </div>
            {hasHandwrittenMemo && (
              <button
                type="button"
                className="session-detail-handwritten-import"
                onClick={() => setHandwrittenMemo("")}
                aria-label={handwrittenMemoClearLabel}
                title={handwrittenMemoClearLabel}
              >
                メモクリア
              </button>
            )}
          </div>
          <div
            className="session-detail-local-minutes-card"
            aria-label={minutesDraftCardAriaLabel}
            title={`${minutesDraftCardHeading}。${aiMinutesTransmissionLabel}`}
          >
            <div className="session-detail-local-minutes-head">
              <div>
                <strong>{minutesDraftCardHeading}</strong>
                <span>{aiMinutesActionDetail}</span>
              </div>
              <span
                className={aiMinutesConnectionClassName}
                aria-label={aiMinutesTransmissionLabel}
                title={aiMinutesTransmissionLabel}
              >
                {aiMinutesConnectionLabel}
              </span>
            </div>
            <div className="session-detail-local-minutes-actions">
              <button
                type="button"
                className="control-btn control-btn-transcribe"
                onClick={handleGenerateLocalMinutesDraft}
                aria-label={`${minutesDraftActionLabel}。${minutesTemplate}。${aiMinutesTransmissionLabel}`}
                title={`${minutesDraftActionLabel}。${minutesTemplate}。${aiMinutesTransmissionLabel}`}
              >
                <FileText size={14} aria-hidden="true" />
                {minutesDraftActionLabel}
              </button>
              {generatedMinutesDraft.trim() ? (
                <button
                  type="button"
                  className="control-btn control-btn-clear"
                  onClick={handleCopyGeneratedMinutesDraft}
                  aria-label={`${minutesDraftCardHeading}をコピー`}
                  title={`${minutesDraftCardHeading}をコピー`}
                >
                  <Clipboard size={14} aria-hidden="true" />
                  {minutesDraftCardHeading}コピー
                </button>
              ) : null}
            </div>
            {generatedMinutesDraft.trim() ? (
              <pre
                className="session-detail-local-minutes-preview"
                aria-label={minutesDraftCardHeading}
              >
                {generatedMinutesDraft}
              </pre>
            ) : (
              <div className="session-detail-local-minutes-empty" role="status">
                {minutesDraftEmptyLabel}
              </div>
            )}
          </div>
        </section>
      </section>
    </div>
  );
}

interface TranscriptTimelineProps {
  parsed: ReturnType<typeof parseSessionMarkdown> | null;
  searchQuery: string;
}

function TranscriptTimeline({ parsed, searchQuery }: TranscriptTimelineProps) {
  if (!parsed || parsed.segments.length === 0) {
    return (
      <p className="session-detail-empty" role="status">
        この録音にはまだ文字起こしがありません。
      </p>
    );
  }
  const visibleSegments = searchQuery
    ? parsed.segments.filter((segment) =>
        [segment.time, segment.speaker, segment.text]
          .join(" ")
          .toLocaleLowerCase("ja-JP")
          .includes(searchQuery),
      )
    : parsed.segments;
  const timelineLabel = searchQuery
    ? `文字起こしタイムライン。検索結果 ${visibleSegments.length} 件、全 ${parsed.segments.length} 件。自分は右、相手側は左。`
    : `文字起こしタイムライン。全 ${parsed.segments.length} 件。自分は右、相手側は左。`;
  if (visibleSegments.length === 0) {
    return (
      <p className="session-detail-empty" role="status">
        検索条件に一致する発話はありません。
      </p>
    );
  }
  return (
    <ol className="session-detail-transcript" aria-label={timelineLabel}>
      {visibleSegments.map((segment, index) => (
        <li
          key={`${segment.time}-${index}`}
          className={getTranscriptBubbleClassName(segment.speaker)}
          aria-label={`${segment.time} ${segment.speaker} ${segment.text}`}
        >
          <span className="session-detail-transcript-bubble">
            <span className="session-detail-transcript-meta">
              <span className="session-detail-transcript-speaker">
                {segment.speaker}
              </span>
              <span className="session-detail-transcript-time">
                {segment.time}
              </span>
            </span>
            <span className="session-detail-transcript-text">
              {segment.text}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function getTranscriptBubbleClassName(speaker: string): string {
  if (speaker === "自分") {
    return "session-detail-transcript-row session-detail-transcript-row-self";
  }
  if (speaker === "相手側") {
    return "session-detail-transcript-row session-detail-transcript-row-other";
  }
  return "session-detail-transcript-row session-detail-transcript-row-unknown";
}
