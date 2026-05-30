import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link } from "@tanstack/react-router";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { History, Search } from "lucide-react";
import { useSessionList, type SessionSummary } from "../hooks/useSessionList";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";
import { toErrorMessage } from "../utils/errorMessage";
import {
  formatSearchQueryForLabel,
  getSearchMatchExcerpt,
  getSessionSearchMatchLabels,
  getSessionStartedAtDisplay,
  getTranscriptTrackCounts,
  hasTranscriptBody,
  renderHighlightedSearchExcerpt,
  sessionMatchesQuery,
} from "../utils/sessionListHelpers";
import {
  getCompactSessionTitle,
  getFileName,
} from "../utils/transcriptViewFormatters";
import { writeClipboardText } from "../utils/clipboard";

type SessionAction =
  | { kind: "reveal"; path: string }
  | { kind: "copy"; path: string }
  | null;

type SessionListFilter = "all" | "transcript" | "separatedTracks";

const EMPTY_SESSIONS: SessionSummary[] = [];

/**
 * 保存済み文字起こし履歴の一覧画面。
 * 各行から録音後レビュー、文字起こしコピー、保存場所表示に進める。
 */
export function SessionList() {
  const { data, isLoading, isFetching, error, refetch } = useSessionList();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<SessionAction>(null);
  const [copiedSessionPath, setCopiedSessionPath] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<SessionListFilter>("all");
  const pendingActionRef = useRef<SessionAction>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!copiedSessionPath) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      if (isMountedRef.current) {
        setCopiedSessionPath(null);
      }
    }, 2400);
    return () => window.clearTimeout(timeoutId);
  }, [copiedSessionPath]);

  const handleRevealInFolder = useCallback(async (path: string) => {
    if (pendingActionRef.current) {
      return;
    }
    const nextAction = { kind: "reveal" as const, path };
    pendingActionRef.current = nextAction;
    setPendingAction(nextAction);
    setActionError(null);
    try {
      await revealItemInDir(path);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(null);
    } catch (e) {
      console.error("保存場所を表示できませんでした:", toErrorMessage(e));
      if (!isMountedRef.current) {
        return;
      }
      setActionError("保存場所を表示できませんでした");
    } finally {
      pendingActionRef.current = null;
      if (isMountedRef.current) {
        setPendingAction(null);
      }
    }
  }, []);

  const handleCopyTranscript = useCallback(
    async (path: string, body: string) => {
      if (pendingActionRef.current) {
        return;
      }
      const nextAction = { kind: "copy" as const, path };
      pendingActionRef.current = nextAction;
      setPendingAction(nextAction);
      setActionError(null);
      try {
        await writeClipboardText(body);
        if (!isMountedRef.current) {
          return;
        }
        setActionError(null);
        setCopiedSessionPath(path);
      } catch (e) {
        console.error("文字起こしをコピーできませんでした:", toErrorMessage(e));
        if (!isMountedRef.current) {
          return;
        }
        setActionError("文字起こしをコピーできませんでした");
      } finally {
        pendingActionRef.current = null;
        if (isMountedRef.current) {
          setPendingAction(null);
        }
      }
    },
    [],
  );

  const clearSearch = useCallback(() => {
    setSearchQuery("");
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape" || !searchQuery) {
        return;
      }
      event.preventDefault();
      clearSearch();
    },
    [clearSearch, searchQuery],
  );

  const sessions = data ?? EMPTY_SESSIONS;
  const trimmedSearchQuery = searchQuery.trim();
  const libraryStats = useMemo(() => {
    let sessionsWithBody = 0;
    let sessionsWithSeparatedTracks = 0;

    for (const session of sessions) {
      if (!hasTranscriptBody(session.searchText)) {
        continue;
      }
      sessionsWithBody += 1;
      const trackCounts = getTranscriptTrackCounts(session.searchText);
      if (trackCounts.self > 0 && trackCounts.other > 0) {
        sessionsWithSeparatedTracks += 1;
      }
    }

    return { sessionsWithBody, sessionsWithSeparatedTracks };
  }, [sessions]);
  const filteredSessions = useMemo(
    () =>
      sessions
        .filter((session) =>
          sessionMatchesQuery(
            session,
            getSessionStartedAtDisplay(session.startedAtSecs).label,
            trimmedSearchQuery,
          ),
        )
        .filter((session) => {
          if (activeFilter === "all") {
            return true;
          }
          if (activeFilter === "transcript") {
            return hasTranscriptBody(session.searchText);
          }
          const trackCounts = getTranscriptTrackCounts(session.searchText);
          return trackCounts.self > 0 && trackCounts.other > 0;
        }),
    [activeFilter, sessions, trimmedSearchQuery],
  );
  if (isLoading) {
    const loadingLabel = "文字起こし履歴一覧を読み込み中";
    return (
      <div
        className="session-list"
        role="status"
        aria-busy={true}
        aria-live="polite"
        aria-atomic="true"
        aria-label={loadingLabel}
        title={loadingLabel}
      >
        履歴読み込み中…
      </div>
    );
  }

  if (error) {
    const errorMessage = toErrorMessage(error);
    const errorLabel = "履歴を読み込めませんでした";
    const retryErrorLabel = isFetching
      ? "文字起こし履歴一覧を読み込み中"
      : "文字起こし履歴一覧を再読み込み";
    return (
      <div className="session-list" aria-busy={isFetching}>
        <p
          className="session-list-error"
          role="alert"
          aria-label={errorLabel}
          title={errorMessage}
        >
          履歴を読み込めませんでした。
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label={retryErrorLabel}
          title={retryErrorLabel}
        >
          {isFetching ? "履歴読み込み中…" : "履歴更新"}
        </button>
      </div>
    );
  }

  const isSessionListBusy = isFetching || pendingAction !== null;
  const searchQueryLabel = formatSearchQueryForLabel(trimmedSearchQuery);
  const reloadSessionsLabel = isFetching
    ? "文字起こし履歴一覧を読み込み中"
    : "文字起こし履歴一覧を再読み込み";
  const sessionCountLabel = isFetching
    ? `保存済み ${sessions.length} 件、更新中`
    : trimmedSearchQuery || activeFilter !== "all"
      ? `保存済み ${sessions.length} 件中 ${filteredSessions.length} 件を表示`
      : `保存済み ${sessions.length} 件`;
  const libraryBodyCountLabel = `文字起こしあり ${libraryStats.sessionsWithBody} 件`;
  const librarySeparatedTracksLabel = `マイク+スピーカートラック ${libraryStats.sessionsWithSeparatedTracks} 件`;
  const libraryCopyScopeLabel = "コピー対象は文字起こし";
  const libraryReviewScopeLabel =
    "録音レビューでマイク/スピーカー音声、チャット文字起こし、手書きメモ、議事録を確認";
  const libraryAiScopeLabel =
    "AI議事録は録音レビュー内で確認。音声トラックはAI送信しません";
  const libraryActionFlow = [
    {
      label: "検索",
      value: trimmedSearchQuery
        ? `${filteredSessions.length}/${sessions.length}件`
        : `${sessions.length}件`,
      tone: "accent",
    },
    {
      label: "コピー",
      value: libraryStats.sessionsWithBody > 0 ? "文字起こし" : "待機",
      tone: libraryStats.sessionsWithBody > 0 ? "neutral" : "muted",
    },
    {
      label: "音声",
      value:
        libraryStats.sessionsWithSeparatedTracks > 0
          ? "マイク/スピーカー"
          : "レビュー内確認",
      tone: libraryStats.sessionsWithSeparatedTracks > 0 ? "safe" : "neutral",
    },
    {
      label: "メモ",
      value: "レビュー内",
      tone: "neutral",
    },
    {
      label: "議事録",
      value: "レビュー内",
      tone: "warn",
    },
  ] as const;
  const libraryActionFlowLabel = [
    "録音後アクション",
    "履歴検索、文字起こしコピー、音声トラック確認、手書きメモ、議事録ワークスペースへ進めます",
    "音声トラックはAI送信しません",
    ...libraryActionFlow.map((item) => `${item.label}: ${item.value}`),
  ].join("。");
  const sessionListFilters = [
    {
      key: "all",
      label: "すべて",
      count: sessions.length,
      description: "保存済み履歴をすべて表示",
    },
    {
      key: "transcript",
      label: "文字起こし",
      count: libraryStats.sessionsWithBody,
      description: "文字起こしが保存されている履歴だけを表示",
    },
    {
      key: "separatedTracks",
      label: "別トラック",
      count: libraryStats.sessionsWithSeparatedTracks,
      description:
        "マイクとスピーカーの文字起こしが両方ある履歴だけを表示",
    },
  ] as const satisfies ReadonlyArray<{
    key: SessionListFilter;
    label: string;
    count: number;
    description: string;
  }>;
  const activeFilterLabel =
    sessionListFilters.find((filter) => filter.key === activeFilter)?.label ??
    "すべて";
  const sessionFilterGroupLabel = `履歴フィルタ。現在は ${activeFilterLabel}。v2の録音後ワークスペースに合わせ、全件、文字起こしあり、マイク+スピーカー別トラックありで絞り込みます。`;
  const sessionSearchLabel = "履歴を検索";
  const sessionSearchInputLabel = trimmedSearchQuery
    ? `${sessionSearchLabel}: ${searchQueryLabel}`
    : sessionSearchLabel;
  const clearSearchLabel = searchQuery
    ? trimmedSearchQuery
      ? `検索語 ${searchQueryLabel} をクリア`
      : "入力中の空白検索をクリア"
    : "検索語は入力されていません";
  const sessionListLabel = [
    "文字起こし履歴",
    sessionCountLabel,
    libraryBodyCountLabel,
    librarySeparatedTracksLabel,
    libraryCopyScopeLabel,
    libraryReviewScopeLabel,
    libraryAiScopeLabel,
    `フィルタ ${activeFilterLabel}`,
    trimmedSearchQuery ? `検索語 ${searchQueryLabel}` : null,
    pendingAction ? "履歴操作中" : null,
  ]
    .filter(Boolean)
    .join("、");
  return (
    <div
      className="session-list"
      aria-busy={isSessionListBusy}
      aria-label={sessionListLabel}
      title={sessionListLabel}
    >
      <div className="session-list-header">
        <div className="session-list-heading">
          <span className="session-list-kicker">録音ライブラリ</span>
          <h2 className="session-list-title">
            <History size={16} aria-hidden="true" />
            履歴ライブラリ
          </h2>
          <div className="session-list-header-meta">
            <span
              className="session-list-count"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={sessionCountLabel}
              title={sessionCountLabel}
            >
              {trimmedSearchQuery
                ? `${filteredSessions.length}/${sessions.length} 件`
                : `${sessions.length} 件`}
              {isFetching ? "、更新中" : ""}
            </span>
            {sessions.length > 0 && (
              <span
                className="session-list-header-chip"
                aria-label={libraryBodyCountLabel}
                title={libraryBodyCountLabel}
              >
                文字起こし {libraryStats.sessionsWithBody}
              </span>
            )}
            {sessions.length > 0 && (
              <span
                className="session-list-header-chip session-list-header-chip-tracks"
                aria-label={librarySeparatedTracksLabel}
                title={librarySeparatedTracksLabel}
              >
                マイク+スピーカー {libraryStats.sessionsWithSeparatedTracks}
              </span>
            )}
            {sessions.length > 0 && (
              <span
                className="session-list-header-chip session-list-header-chip-copy"
                aria-label={libraryCopyScopeLabel}
                title={libraryCopyScopeLabel}
              >
                コピー: 文字起こし
              </span>
            )}
            {sessions.length > 0 && (
              <span
                className="session-list-header-chip session-list-header-chip-review"
                aria-label={libraryReviewScopeLabel}
                title={libraryReviewScopeLabel}
              >
                レビュー: 音声 / チャット / メモ / 議事録
              </span>
            )}
            {sessions.length > 0 && (
              <span
                className="session-list-header-chip session-list-header-chip-ai"
                aria-label={libraryAiScopeLabel}
                title={libraryAiScopeLabel}
              >
                AI: レビュー内確認
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label={reloadSessionsLabel}
          title={reloadSessionsLabel}
        >
          {isFetching ? "履歴読み込み中…" : "履歴更新"}
        </button>
      </div>

      {sessions.length > 0 && (
        <div
          className="session-list-action-flow"
          role="status"
          aria-label={libraryActionFlowLabel}
          title={libraryActionFlowLabel}
        >
          {libraryActionFlow.map((item) => (
            <span
              key={`${item.label}-${item.value}`}
              className={`session-list-action-chip session-list-action-chip-${item.tone}`}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <div
          className="session-list-filter-segments"
          role="group"
          aria-label={sessionFilterGroupLabel}
          title={sessionFilterGroupLabel}
        >
          {sessionListFilters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={
                activeFilter === filter.key
                  ? "session-list-filter-chip session-list-filter-chip-active"
                  : "session-list-filter-chip"
              }
              aria-pressed={activeFilter === filter.key}
              aria-label={`${filter.label} フィルタ。${filter.description}。${filter.count} 件。`}
              title={`${filter.description}。${filter.count} 件。`}
              onClick={() => setActiveFilter(filter.key)}
            >
              <span>{filter.label}</span>
              <strong>{filter.count}</strong>
            </button>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <label className="session-list-search">
          <span className="session-list-search-label">
            <Search size={14} aria-hidden="true" />
            履歴検索
          </span>
          <span className="session-list-search-row">
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="タイトル、文字起こし、自分/相手側"
              aria-label={sessionSearchInputLabel}
              title={sessionSearchInputLabel}
            />
            {searchQuery && (
              <button
                type="button"
                className="control-btn control-btn-clear session-list-search-clear"
                onClick={clearSearch}
                aria-label={clearSearchLabel}
                title={clearSearchLabel}
                aria-keyshortcuts="Escape"
              >
                検索クリア
              </button>
            )}
          </span>
        </label>
      )}

      {actionError && (
        <div
          className="session-list-error"
          role="alert"
          aria-label={actionError}
          title={actionError}
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => setActionError(null)}
            aria-label="履歴エラーを閉じる"
            title="履歴エラーを閉じる"
          >
            履歴エラーを閉じる
          </button>
        </div>
      )}

      {sessions.length === 0 ? (
        <div
          className="session-list-empty session-list-empty-onboarding"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="履歴はまだありません。会議検知通知またはメニューバー録音から開始すると、録音後レビューでマイク/スピーカー音声、チャット文字起こし、議事録を確認できます。"
          title="履歴はまだありません。会議検知通知またはメニューバー録音から開始します。"
        >
          <strong>履歴はまだありません</strong>
          <small>検知またはメニューバーから録音します。</small>
          <span
            className="session-list-empty-routes"
            role="list"
            aria-label="録音開始経路。会議検知通知、またはメニューバー録音。"
          >
            <span role="listitem">会議検知通知</span>
            <span role="listitem">メニューバー録音</span>
          </span>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div
          className="session-list-empty session-list-empty-actionable"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`一致なし: ${searchQueryLabel}`}
          title={`一致なし: ${searchQueryLabel}`}
        >
          <span>一致する履歴はありません</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={clearSearch}
            aria-label={clearSearchLabel}
            title={clearSearchLabel}
            aria-keyshortcuts="Escape"
          >
            検索クリア
          </button>
        </div>
      ) : (
        <ul className="session-list-items">
          {filteredSessions.map((session) => (
            <SessionRow
              key={session.path}
              session={session}
              searchQuery={trimmedSearchQuery}
              pendingAction={pendingAction}
              copiedSessionPath={copiedSessionPath}
              onRevealInFolder={handleRevealInFolder}
              onCopyTranscript={handleCopyTranscript}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  searchQuery: string;
  pendingAction: SessionAction;
  copiedSessionPath: string | null;
  onRevealInFolder: (path: string) => void;
  onCopyTranscript: (path: string, body: string) => void;
}

function SessionRow({
  session,
  searchQuery,
  pendingAction,
  copiedSessionPath,
  onRevealInFolder,
  onCopyTranscript,
}: SessionRowProps) {
  // 秒 → ミリ秒に変換してローカルタイムでフォーマット。
  // タイムゾーンはユーザーの OS 設定に従うため、JST ハードコード（バックエンド表示用）とは独立。
  const startedAtDisplay = getSessionStartedAtDisplay(session.startedAtSecs);
  const startedAtLabel = startedAtDisplay.label;
  const displayTitle = getCompactSessionTitle(session.title);
  const fileName = getFileName(session.path);
  const searchExcerpt = getSearchMatchExcerpt(session.searchText, searchQuery);
  const searchMatchLabels = getSessionSearchMatchLabels(
    session,
    startedAtLabel,
    searchQuery,
  );
  const searchMatchLabelText =
    searchMatchLabels.length > 0
      ? `一致: ${searchMatchLabels.join("、")}`
      : null;
  const hasBody = hasTranscriptBody(session.searchText);
  const trackCounts = getTranscriptTrackCounts(session.searchText);
  const transcriptBodyLabel = hasBody
    ? "文字起こしあり"
    : "文字起こしなし";
  const trackCountsLabel = hasBody
    ? [
        `${SELF_TRACK_DEVICE_LABEL} ${trackCounts.self} 件`,
        `${OTHER_TRACK_DEVICE_LABEL} ${trackCounts.other} 件`,
        trackCounts.unknown > 0
          ? `音声ソース不明 ${trackCounts.unknown} 件`
          : null,
      ]
        .filter(Boolean)
        .join("、")
    : null;
  const hasSeparatedTracks = trackCounts.self > 0 && trackCounts.other > 0;
  const sessionReviewFlow = [
    {
      label: "文字起こし",
      value: hasBody ? "コピー可" : "なし",
      tone: hasBody ? "accent" : "muted",
    },
    {
      label: "トラック",
      value: hasSeparatedTracks
        ? "マイク/スピーカー"
        : hasBody
          ? "片側/不明"
          : "確認待ち",
      tone: hasSeparatedTracks ? "safe" : hasBody ? "warn" : "muted",
    },
    {
      label: "レビュー",
      value: "音声/議事録",
      tone: "accent",
    },
    {
      label: "メモ",
      value: "追記可",
      tone: "neutral",
    },
    {
      label: "送信",
      value: "音声なし",
      tone: "safe",
    },
  ] as const;
  const sessionReviewFlowLabel = [
    `録音後レビュー導線: ${displayTitle}`,
    hasBody ? "文字起こしをコピーできます" : "文字起こしは未保存です",
    hasSeparatedTracks
      ? "マイクとスピーカーの文字起こしがあります"
      : "トラック分離は詳細で確認します",
    "録音レビューで音声トラック、チャット文字起こし、手書きメモ、議事録ワークスペースを開きます",
    "音声トラックはAI送信しません",
  ].join("。");
  const isAnyActionPending = pendingAction !== null;
  const isRevealingThisFile =
    pendingAction?.kind === "reveal" && pendingAction.path === session.path;
  const isCopyingThisFile =
    pendingAction?.kind === "copy" && pendingAction.path === session.path;
  const isCopiedThisFile = copiedSessionPath === session.path;
  const isWaitingForOtherAction =
    isAnyActionPending && !isRevealingThisFile && !isCopyingThisFile;
  const otherActionLabel =
    pendingAction?.kind === "reveal"
      ? "他の保存場所を表示中"
      : pendingAction?.kind === "copy"
        ? "他の文字起こしをコピー中"
        : "他のセッション操作を処理中";
  const otherActionButtonText =
    pendingAction?.kind === "reveal"
      ? "別保存場所を表示中"
      : pendingAction?.kind === "copy"
        ? "別文字起こしをコピー中"
        : "他の処理中";
  const revealFileLabel = isRevealingThisFile
    ? `保存場所を表示中: ${displayTitle}`
    : isWaitingForOtherAction
      ? `${otherActionLabel}: ${displayTitle}`
      : `保存場所を表示: ${displayTitle}`;
  const copyTranscriptLabel = isCopyingThisFile
    ? `文字起こしをコピー中: ${displayTitle}`
    : isCopiedThisFile
      ? `文字起こしをコピー済み: ${displayTitle}`
      : isWaitingForOtherAction
        ? `${otherActionLabel}: ${displayTitle}`
        : `文字起こしをコピー: ${displayTitle}`;
  const reviewSessionLabel = [
    `録音レビューを開く: ${displayTitle}`,
    searchQuery ? "検索結果ではなく録音全体を開きます" : null,
    "マイク/スピーカー音声",
    "チャット文字起こし",
    "文字起こしコピー",
    "手書きメモ",
    "議事録ワークスペース",
    "AI議事録はレビュー内で確認",
    "音声トラックはAI送信しません",
  ]
    .filter(Boolean)
    .join("。");
  const sessionActionsLabel = isRevealingThisFile
    ? `操作: ${displayTitle}、保存場所を表示中`
    : isCopyingThisFile
      ? `操作: ${displayTitle}、文字起こしをコピー中`
      : isCopiedThisFile
        ? `操作: ${displayTitle}、文字起こしをコピー済み`
        : isWaitingForOtherAction
          ? `操作: ${displayTitle}、${otherActionLabel}`
          : `操作: ${displayTitle}`;

  return (
    <li
      className="session-list-item"
      aria-label={[
        `セッション ${displayTitle}`,
        `開始 ${startedAtLabel}`,
        transcriptBodyLabel,
        trackCountsLabel,
        `保存名 ${fileName}`,
        searchMatchLabelText,
        searchExcerpt ? `文字起こし一致 ${searchExcerpt}` : null,
      ]
        .filter(Boolean)
        .join("、")}
      title={[
        `セッション ${displayTitle}`,
        `開始 ${startedAtLabel}`,
        transcriptBodyLabel,
        trackCountsLabel,
        `保存名 ${fileName}`,
        searchMatchLabelText,
        searchExcerpt ? `文字起こし一致 ${searchExcerpt}` : null,
      ]
        .filter(Boolean)
        .join("、")}
    >
      <div className="session-list-item-body">
        <div className="session-list-item-title" title={displayTitle}>
          {displayTitle}
        </div>
        <div className="session-list-item-meta">
          {startedAtDisplay.iso ? (
            <time dateTime={startedAtDisplay.iso}>{startedAtLabel}</time>
          ) : (
            <span>{startedAtLabel}</span>
          )}
          <span
            className="session-list-item-body-state"
            aria-label={transcriptBodyLabel}
            title={transcriptBodyLabel}
          >
            {hasBody ? "文字起こしあり" : "文字起こしなし"}
          </span>
          {hasBody && (
            <>
              <span
                className="session-list-item-track-count session-list-item-track-count-self"
                aria-label={`${SELF_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.self} 件`}
                title={`${SELF_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.self} 件`}
              >
                マイク {trackCounts.self}
              </span>
              <span
                className="session-list-item-track-count session-list-item-track-count-other"
                aria-label={`${OTHER_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.other} 件`}
                title={`${OTHER_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.other} 件`}
              >
                スピーカー {trackCounts.other}
              </span>
              {trackCounts.unknown > 0 && (
                <span
                  className="session-list-item-track-count session-list-item-track-count-unknown"
                  aria-label={`音声ソース不明の文字起こし ${trackCounts.unknown} 件`}
                  title={`音声ソース不明の文字起こし ${trackCounts.unknown} 件`}
                >
                  不明 {trackCounts.unknown}
                </span>
              )}
            </>
          )}
          {searchMatchLabelText && (
            <span
              className="session-list-item-match-reason"
              aria-label={searchMatchLabelText}
              title={searchMatchLabelText}
            >
              {searchMatchLabelText}
            </span>
          )}
        </div>
        <div
          className="session-list-item-flow"
          role="status"
          aria-label={sessionReviewFlowLabel}
          title={sessionReviewFlowLabel}
        >
          {sessionReviewFlow.map((item) => (
            <span
              key={`${item.label}-${item.value}`}
              className={`session-list-item-flow-chip session-list-item-flow-chip-${item.tone}`}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
        {searchExcerpt && (
          <div
            className="session-list-item-excerpt"
            aria-label={`文字起こし一致: ${searchExcerpt}`}
            title={`文字起こし一致: ${searchExcerpt}`}
          >
            {renderHighlightedSearchExcerpt(searchExcerpt, searchQuery)}
          </div>
        )}
      </div>
      <div
        className="session-list-item-actions"
        role="group"
        aria-busy={isRevealingThisFile || isCopyingThisFile}
        aria-label={sessionActionsLabel}
        title={sessionActionsLabel}
      >
        <Link
          to="/sessions/$encodedPath"
          params={{ encodedPath: encodeURIComponent(session.path) }}
          className="control-btn control-btn-transcribe control-btn-detail session-list-review-primary"
          aria-label={reviewSessionLabel}
          title={reviewSessionLabel}
        >
          録音レビュー
        </Link>
        <div className="session-list-item-secondary-actions">
          {hasBody && (
            <button
              type="button"
              className={
                isCopiedThisFile
                  ? "control-btn control-btn-clear session-list-copy-done"
                  : "control-btn control-btn-clear"
              }
              aria-label={copyTranscriptLabel}
              title={copyTranscriptLabel}
              onClick={() => onCopyTranscript(session.path, session.searchText)}
              disabled={isAnyActionPending}
            >
              {isCopyingThisFile
                ? "文字起こしコピー中…"
                : isCopiedThisFile
                  ? "文字起こしコピー済み"
                  : isWaitingForOtherAction
                    ? otherActionButtonText
                    : "文字起こしコピー"}
            </button>
          )}
          <button
            type="button"
            className="control-btn control-btn-clear"
            aria-label={revealFileLabel}
            title={revealFileLabel}
            onClick={() => onRevealInFolder(session.path)}
            disabled={isAnyActionPending}
          >
            {isRevealingThisFile
              ? "保存場所表示中…"
              : isWaitingForOtherAction
                ? otherActionButtonText
                : "保存場所表示"}
          </button>
        </div>
      </div>
    </li>
  );
}
