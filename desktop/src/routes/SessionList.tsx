import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSessionList, type SessionSummary } from "../hooks/useSessionList";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";
import { toErrorMessage } from "../utils/errorMessage";

type SessionAction =
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string }
  | null;

const SEARCH_QUERY_LABEL_MAX_LENGTH = 40;
const SEARCH_EXCERPT_CONTEXT_LENGTH = 42;
const EMPTY_SESSIONS: SessionSummary[] = [];

interface TranscriptTrackCounts {
  self: number;
  other: number;
  unknown: number;
}

interface SessionStartedAtDisplay {
  label: string;
  iso: string | null;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function getSessionStartedAtDisplay(
  startedAtSecs: number,
): SessionStartedAtDisplay {
  const startedAtMs = startedAtSecs * 1000;
  if (!Number.isFinite(startedAtMs)) {
    return { label: "日時不明", iso: null };
  }
  const startedAtDate = new Date(startedAtMs);
  if (Number.isNaN(startedAtDate.getTime())) {
    return { label: "日時不明", iso: null };
  }
  return {
    label: startedAtDate.toLocaleString(),
    iso: startedAtDate.toISOString(),
  };
}

function formatSearchQueryForLabel(query: string): string {
  const normalized = query.split(/\s+/).filter(Boolean).join(" ");
  return normalized.length > SEARCH_QUERY_LABEL_MAX_LENGTH
    ? `${normalized.slice(0, SEARCH_QUERY_LABEL_MAX_LENGTH)}...`
    : normalized;
}

function getSearchTerms(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function getSessionDisplayTitle(title: string): string {
  const displayTitle = title
    .replace(/\s-\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/, "")
    .trim();
  return displayTitle || "無題の会議";
}

function unescapeInlineMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_[\]])/g, "$1");
}

function formatSearchExcerptText(text: string): string {
  return unescapeInlineMarkdownText(text)
    .replace(/\*\*\[([^\]]+)\]\s*([^:*]+):\*\*/g, "[$1] $2:")
    .replace(/\s+/g, " ")
    .trim();
}

function getSearchMatchExcerpt(text: string, query: string): string | null {
  const searchTerms = getSearchTerms(query);
  if (searchTerms.length === 0 || !text) {
    return null;
  }
  const searchText = unescapeInlineMarkdownText(text);
  const normalizedText = searchText.toLocaleLowerCase();
  const matchedTerm = searchTerms.find((term) => normalizedText.includes(term));
  if (!matchedTerm) {
    return null;
  }
  const matchIndex = normalizedText.indexOf(matchedTerm);
  if (matchIndex < 0) {
    return null;
  }
  const start = Math.max(0, matchIndex - SEARCH_EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(
    searchText.length,
    matchIndex + matchedTerm.length + SEARCH_EXCERPT_CONTEXT_LENGTH,
  );
  const excerpt = formatSearchExcerptText(searchText.slice(start, end));
  if (!excerpt) {
    return null;
  }
  return `${start > 0 ? "..." : ""}${excerpt}${end < searchText.length ? "..." : ""}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedSearchExcerpt(
  text: string,
  query: string,
): ReactNode {
  const searchTerms = Array.from(new Set(getSearchTerms(query)))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (searchTerms.length === 0) {
    return text;
  }

  const matcher = new RegExp(`(${searchTerms.join("|")})`, "gi");
  const exactMatcher = new RegExp(`^(${searchTerms.join("|")})$`, "i");
  return text.split(matcher).map((part, index) =>
    exactMatcher.test(part) ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      part
    ),
  );
}

function hasTranscriptBody(searchText: string): boolean {
  return searchText.trim().length > 0;
}

function getTranscriptTrackCounts(searchText: string): TranscriptTrackCounts {
  const counts = { self: 0, other: 0, unknown: 0 };
  for (const match of searchText.matchAll(/\*\*\[[^\]]+\]\s*([^:*]+):\*\*/g)) {
    const speaker = match[1]?.trim();
    if (speaker === "自分") {
      counts.self += 1;
    } else if (speaker === "相手側") {
      counts.other += 1;
    } else if (speaker) {
      counts.unknown += 1;
    }
  }
  return counts;
}

function sessionMatchesQuery(
  session: SessionSummary,
  startedAtLabel: string,
  query: string,
): boolean {
  const searchTerms = getSearchTerms(query);
  if (searchTerms.length === 0) {
    return true;
  }
  const searchableText = [
    getSessionDisplayTitle(session.title),
    getFileName(session.path),
    startedAtLabel,
    unescapeInlineMarkdownText(session.searchText),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return searchTerms.every((term) => searchableText.includes(term));
}

/**
 * 保存済みセッションの一覧画面。
 * 各行から「履歴ファイルを開く」「Finder で表示」で macOS のデフォルトアプリ / Finder に
 * 解決させる。
 */
export function SessionList() {
  const { data, isLoading, isFetching, error, refetch } = useSessionList();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<SessionAction>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const pendingActionRef = useRef<SessionAction>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleOpenFile = useCallback(async (path: string) => {
    if (pendingActionRef.current) {
      return;
    }
    const nextAction = { kind: "open" as const, path };
    pendingActionRef.current = nextAction;
    setPendingAction(nextAction);
    setActionError(null);
    try {
      await openPath(path);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(null);
    } catch (e) {
      console.error("履歴ファイルを開けませんでした:", e);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(
        `履歴ファイルを開けませんでした (${getFileName(path)}): ${toErrorMessage(e)}`,
      );
    } finally {
      pendingActionRef.current = null;
      if (isMountedRef.current) {
        setPendingAction(null);
      }
    }
  }, []);

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
      console.error("Finder で表示できませんでした:", e);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(
        `履歴ファイルを Finder で表示できませんでした (${getFileName(path)}): ${toErrorMessage(e)}`,
      );
    } finally {
      pendingActionRef.current = null;
      if (isMountedRef.current) {
        setPendingAction(null);
      }
    }
  }, []);

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
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) =>
        sessionMatchesQuery(
          session,
          getSessionStartedAtDisplay(session.startedAtSecs).label,
          trimmedSearchQuery,
        ),
      ),
    [sessions, trimmedSearchQuery],
  );

  if (isLoading) {
    const loadingLabel = "セッション履歴一覧を読み込み中";
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
        読み込み中...
      </div>
    );
  }

  if (error) {
    const errorMessage = toErrorMessage(error);
    const errorLabel = `セッション履歴一覧エラー: ${errorMessage}`;
    const retryErrorLabel = isFetching
      ? "セッション履歴一覧を読み込み中"
      : "セッション履歴一覧を再読み込み";
    return (
      <div className="session-list" aria-busy={isFetching}>
        <p
          className="session-list-error"
          role="alert"
          aria-label={errorLabel}
          title={errorLabel}
        >
          セッション履歴一覧の取得に失敗しました: {errorMessage}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label={retryErrorLabel}
          title={retryErrorLabel}
        >
          {isFetching ? "読み込み中..." : "履歴を再読み込み"}
        </button>
      </div>
    );
  }

  const isSessionListBusy = isFetching || pendingAction !== null;
  const searchQueryLabel = formatSearchQueryForLabel(trimmedSearchQuery);
  const reloadSessionsLabel = isFetching
    ? "セッション履歴一覧を読み込み中"
    : "セッション履歴一覧を再読み込み";
  const sessionCountLabel = isFetching
    ? `保存済み ${sessions.length} 件、更新中`
    : trimmedSearchQuery
      ? `保存済み ${sessions.length} 件中 ${filteredSessions.length} 件を表示`
      : `保存済み ${sessions.length} 件`;
  const sessionSearchLabel =
    "セッション履歴を検索。スペース区切りで複数語を指定できます";
  const clearSearchLabel = trimmedSearchQuery
    ? `検索語 ${searchQueryLabel} をクリア`
    : "検索語は入力されていません";
  const sessionListLabel = [
    "セッション履歴",
    sessionCountLabel,
    trimmedSearchQuery ? `検索語 ${searchQueryLabel}` : null,
    pendingAction ? "履歴ファイル操作中" : null,
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
          <h2 className="session-list-title">セッション履歴</h2>
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
        </div>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label={reloadSessionsLabel}
          title={reloadSessionsLabel}
        >
          {isFetching ? "読み込み中..." : "履歴を再読み込み"}
        </button>
      </div>

      {sessions.length > 0 && (
        <label className="session-list-search">
          <span>{sessionSearchLabel}</span>
          <span className="session-list-search-row">
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="タイトル、本文、日時、ファイル名を複数語で検索"
              aria-label={sessionSearchLabel}
              title={sessionSearchLabel}
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
                クリア
              </button>
            )}
          </span>
        </label>
      )}

      {actionError && (
        <div
          className="session-list-error"
          role="alert"
          aria-label={`セッション履歴ファイル操作エラー: ${actionError}`}
          title={`セッション履歴ファイル操作エラー: ${actionError}`}
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => setActionError(null)}
            aria-label="セッション履歴ファイル操作エラーを閉じる"
            title="セッション履歴ファイル操作エラーを閉じる"
          >
            閉じる
          </button>
        </div>
      )}

      {sessions.length === 0 ? (
        <p
          className="session-list-empty"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="保存された文字起こし履歴はまだありません。記録を終了すると、ここに表示されます"
          title="保存された文字起こし履歴はまだありません。記録を終了すると、ここに表示されます"
        >
          記録を終了すると、保存された文字起こし履歴がここに表示されます
        </p>
      ) : filteredSessions.length === 0 ? (
        <div
          className="session-list-empty session-list-empty-actionable"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`検索条件 ${searchQueryLabel} に一致する文字起こし履歴はありません`}
          title={`検索条件 ${searchQueryLabel} に一致する文字起こし履歴はありません`}
        >
          <span>検索条件に一致する文字起こし履歴はありません</span>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={clearSearch}
            aria-label={clearSearchLabel}
            title={clearSearchLabel}
            aria-keyshortcuts="Escape"
          >
            検索をクリア
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
              onOpenFile={handleOpenFile}
              onRevealInFolder={handleRevealInFolder}
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
  onOpenFile: (path: string) => void;
  onRevealInFolder: (path: string) => void;
}

function SessionRow({
  session,
  searchQuery,
  pendingAction,
  onOpenFile,
  onRevealInFolder,
}: SessionRowProps) {
  // 秒 → ミリ秒に変換してローカルタイムでフォーマット。
  // タイムゾーンはユーザーの OS 設定に従うため、JST ハードコード（バックエンド表示用）とは独立。
  const startedAtDisplay = getSessionStartedAtDisplay(session.startedAtSecs);
  const startedAtLabel = startedAtDisplay.label;
  const displayTitle = getSessionDisplayTitle(session.title);
  const fileName = getFileName(session.path);
  const searchExcerpt = getSearchMatchExcerpt(session.searchText, searchQuery);
  const hasBody = hasTranscriptBody(session.searchText);
  const trackCounts = getTranscriptTrackCounts(session.searchText);
  const transcriptBodyLabel = hasBody ? "文字起こし本文あり" : "文字起こし本文なし";
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
  const isAnyActionPending = pendingAction !== null;
  const isOpeningThisFile =
    pendingAction?.kind === "open" && pendingAction.path === session.path;
  const isRevealingThisFile =
    pendingAction?.kind === "reveal" && pendingAction.path === session.path;
  const isWaitingForOtherAction =
    isAnyActionPending && !isOpeningThisFile && !isRevealingThisFile;
  const otherActionLabel =
    pendingAction?.kind === "open"
      ? "他の履歴ファイルを macOS の既定アプリで開いています"
      : pendingAction?.kind === "reveal"
        ? "他の履歴ファイルを Finder で表示しています"
        : "他のセッション操作を処理中";
  const otherActionButtonText =
    pendingAction?.kind === "open"
      ? "別履歴を開いています"
      : pendingAction?.kind === "reveal"
        ? "別履歴を表示中"
        : "他の処理中";
  const openFileLabel = isOpeningThisFile
    ? `履歴ファイルを macOS の既定アプリで開いています: ${displayTitle}`
    : isWaitingForOtherAction
      ? `${otherActionLabel}: ${displayTitle}`
      : `履歴ファイルを macOS の既定アプリで開く: ${displayTitle}`;
  const revealFileLabel = isRevealingThisFile
    ? `履歴ファイルを Finder で表示しています: ${displayTitle}`
    : isWaitingForOtherAction
      ? `${otherActionLabel}: ${displayTitle}`
      : `履歴ファイルを Finder で表示: ${displayTitle}`;
  const sessionActionsLabel = isOpeningThisFile
    ? `セッション操作: ${displayTitle}、履歴ファイルを macOS の既定アプリで開いています`
    : isRevealingThisFile
      ? `セッション操作: ${displayTitle}、履歴ファイルを Finder で表示しています`
      : isWaitingForOtherAction
        ? `セッション操作: ${displayTitle}、${otherActionLabel}`
        : `セッション操作: ${displayTitle}`;

  return (
    <li
      className="session-list-item"
      aria-label={[
        `セッション ${displayTitle}`,
        `開始 ${startedAtLabel}`,
        transcriptBodyLabel,
        trackCountsLabel,
        `ファイル ${fileName}`,
        searchExcerpt ? `本文一致 ${searchExcerpt}` : null,
      ]
        .filter(Boolean)
        .join("、")}
      title={[
        `セッション ${displayTitle}`,
        `開始 ${startedAtLabel}`,
        transcriptBodyLabel,
        trackCountsLabel,
        `ファイル ${fileName}`,
        searchExcerpt ? `本文一致 ${searchExcerpt}` : null,
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
            {hasBody ? "本文あり" : "本文なし"}
          </span>
          {hasBody && (
            <>
              <span
                className="session-list-item-track-count session-list-item-track-count-self"
                aria-label={`${SELF_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.self} 件`}
                title={`${SELF_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.self} 件`}
              >
                自分 {trackCounts.self}
              </span>
              <span
                className="session-list-item-track-count session-list-item-track-count-other"
                aria-label={`${OTHER_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.other} 件`}
                title={`${OTHER_TRACK_DEVICE_LABEL}の文字起こし ${trackCounts.other} 件`}
              >
                相手側 {trackCounts.other}
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
          <span
            className="session-list-item-file"
            aria-label={`保存ファイル ${fileName}`}
            title={`保存ファイル ${fileName}`}
          >
            {fileName}
          </span>
        </div>
        {searchExcerpt && (
          <div
            className="session-list-item-excerpt"
            aria-label={`本文一致: ${searchExcerpt}`}
            title={`本文一致: ${searchExcerpt}`}
          >
            {renderHighlightedSearchExcerpt(searchExcerpt, searchQuery)}
          </div>
        )}
      </div>
      <div
        className="session-list-item-actions"
        role="group"
        aria-busy={isOpeningThisFile || isRevealingThisFile}
        aria-label={sessionActionsLabel}
        title={sessionActionsLabel}
      >
        <button
          type="button"
          className="control-btn control-btn-transcribe"
          aria-label={openFileLabel}
          title={openFileLabel}
          onClick={() => onOpenFile(session.path)}
          disabled={isAnyActionPending}
        >
          {isOpeningThisFile
            ? "開いています..."
            : isWaitingForOtherAction
              ? otherActionButtonText
              : "履歴ファイルを開く"}
        </button>
        <button
          type="button"
          className="control-btn control-btn-clear"
          aria-label={revealFileLabel}
          title={revealFileLabel}
          onClick={() => onRevealInFolder(session.path)}
          disabled={isAnyActionPending}
        >
          {isRevealingThisFile
            ? "表示中..."
            : isWaitingForOtherAction
              ? otherActionButtonText
              : "Finder で表示"}
        </button>
      </div>
    </li>
  );
}
