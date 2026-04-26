import { useCallback, useEffect, useRef, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSessionList, type SessionSummary } from "../hooks/useSessionList";

type SessionAction =
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string }
  | null;

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
    return (
      <div className="session-list" role="status">
        読み込み中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="session-list">
        <p className="session-list-error" role="alert">
          セッション一覧の取得に失敗しました: {String(error)}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "読み込み中..." : "再読み込み"}
        </button>
      </div>
    );
  }

  const sessions = data ?? [];

  return (
    <div className="session-list">
      <div className="session-list-header">
        <h2 className="session-list-title">セッション履歴</h2>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "読み込み中..." : "再読み込み"}
        </button>
      </div>

      {actionError && (
        <p className="session-list-error" role="alert">
          {actionError}
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="session-list-empty" role="status">
          履歴がまだありません
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
  const isAnyActionPending = pendingAction !== null;
  const isOpeningThisFile =
    pendingAction?.kind === "open" && pendingAction.path === session.path;
  const isRevealingThisFile =
    pendingAction?.kind === "reveal" && pendingAction.path === session.path;

  return (
    <li className="session-list-item">
      <div className="session-list-item-body">
        <div className="session-list-item-title">{session.title}</div>
        <div className="session-list-item-meta">{startedAtLabel}</div>
      </div>
      <div className="session-list-item-actions">
        <button
          type="button"
          className="control-btn control-btn-transcribe"
          aria-label={`ファイルを開く: ${session.title}`}
          onClick={() => onOpenFile(session.path)}
          disabled={isAnyActionPending}
        >
          {isOpeningThisFile ? "開いています..." : "ファイルを開く"}
        </button>
        <button
          type="button"
          className="control-btn control-btn-clear"
          aria-label={`フォルダを開く: ${session.title}`}
          onClick={() => onRevealInFolder(session.path)}
          disabled={isAnyActionPending}
        >
          {isRevealingThisFile ? "開いています..." : "フォルダを開く"}
        </button>
      </div>
    </li>
  );
}
