import { useCallback, useEffect, useRef, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSessionList, type SessionSummary } from "../hooks/useSessionList";

type SessionAction =
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string }
  | null;

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 保存済みセッションの一覧画面。
 * 各行から「ファイルを開く」「フォルダを開く」で OS のデフォルトアプリ / エクスプローラに
 * 解決させる。
 */
export function SessionList() {
  const { data, isLoading, isFetching, error, refetch } = useSessionList();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<SessionAction>(null);
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
    try {
      await openPath(path);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(null);
    } catch (e) {
      console.error("ファイルを開けませんでした:", e);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(`ファイルを開けませんでした: ${String(e)}`);
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
    try {
      await revealItemInDir(path);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(null);
    } catch (e) {
      console.error("フォルダを開けませんでした:", e);
      if (!isMountedRef.current) {
        return;
      }
      setActionError(`フォルダを開けませんでした: ${String(e)}`);
    } finally {
      pendingActionRef.current = null;
      if (isMountedRef.current) {
        setPendingAction(null);
      }
    }
  }, []);

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
    const errorLabel = `セッション履歴一覧エラー: ${String(error)}`;
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
          セッション一覧の取得に失敗しました: {String(error)}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label={retryErrorLabel}
          title={retryErrorLabel}
        >
          {isFetching ? "読み込み中..." : "再読み込み"}
        </button>
      </div>
    );
  }

  const sessions = data ?? [];
  const reloadSessionsLabel = isFetching
    ? "セッション履歴一覧を読み込み中"
    : "セッション履歴一覧を再読み込み";
  const sessionCountLabel = isFetching
    ? `保存済み ${sessions.length} 件、更新中`
    : `保存済み ${sessions.length} 件`;

  return (
    <div className="session-list" aria-busy={isFetching}>
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
            {sessions.length} 件{isFetching ? " / 更新中" : ""}
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
          {isFetching ? "読み込み中..." : "再読み込み"}
        </button>
      </div>

      {actionError && (
        <p
          className="session-list-error"
          role="alert"
          aria-label={`セッション履歴ファイル操作エラー: ${actionError}`}
          title={`セッション履歴ファイル操作エラー: ${actionError}`}
        >
          {actionError}
        </p>
      )}

      {sessions.length === 0 ? (
        <p
          className="session-list-empty"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="保存された文字起こし履歴はまだありません"
          title="保存された文字起こし履歴はまだありません"
        >
          会議を終了すると、保存された文字起こし履歴がここに表示されます
        </p>
      ) : (
        <ul className="session-list-items">
          {sessions.map((session) => (
            <SessionRow
              key={session.path}
              session={session}
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
  pendingAction: SessionAction;
  onOpenFile: (path: string) => void;
  onRevealInFolder: (path: string) => void;
}

function SessionRow({
  session,
  pendingAction,
  onOpenFile,
  onRevealInFolder,
}: SessionRowProps) {
  // 秒 → ミリ秒に変換してローカルタイムでフォーマット。
  // タイムゾーンはユーザーの OS 設定に従うため、JST ハードコード（バックエンド表示用）とは独立。
  const startedAtLabel = new Date(session.startedAtSecs * 1000).toLocaleString();
  const fileName = getFileName(session.path);
  const isAnyActionPending = pendingAction !== null;
  const isOpeningThisFile =
    pendingAction?.kind === "open" && pendingAction.path === session.path;
  const isRevealingThisFile =
    pendingAction?.kind === "reveal" && pendingAction.path === session.path;
  const openFileLabel = isOpeningThisFile
    ? `ファイルを開いています: ${session.title}`
    : `ファイルを開く: ${session.title}`;
  const revealFileLabel = isRevealingThisFile
    ? `保存場所を表示しています: ${session.title}`
    : `保存場所を表示: ${session.title}`;

  return (
    <li
      className="session-list-item"
      aria-label={`セッション ${session.title}、開始 ${startedAtLabel}、ファイル ${fileName}`}
      title={`セッション ${session.title}、開始 ${startedAtLabel}、ファイル ${fileName}`}
    >
      <div className="session-list-item-body">
        <div className="session-list-item-title" title={session.title}>
          {session.title}
        </div>
        <div className="session-list-item-meta">
          <span>{startedAtLabel}</span>
          <span
            className="session-list-item-file"
            aria-label={`保存ファイル ${fileName}`}
            title={`保存ファイル ${fileName}`}
          >
            {fileName}
          </span>
        </div>
      </div>
      <div
        className="session-list-item-actions"
        role="group"
        aria-busy={isOpeningThisFile || isRevealingThisFile}
        aria-label={`セッション操作: ${session.title}`}
        title={`セッション操作: ${session.title}`}
      >
        <button
          type="button"
          className="control-btn control-btn-transcribe"
          aria-label={openFileLabel}
          title={openFileLabel}
          onClick={() => onOpenFile(session.path)}
          disabled={isAnyActionPending}
        >
          {isOpeningThisFile ? "開いています..." : "ファイルを開く"}
        </button>
        <button
          type="button"
          className="control-btn control-btn-clear"
          aria-label={revealFileLabel}
          title={revealFileLabel}
          onClick={() => onRevealInFolder(session.path)}
          disabled={isAnyActionPending}
        >
          {isRevealingThisFile ? "表示中..." : "保存場所を表示"}
        </button>
      </div>
    </li>
  );
}
