import { useCallback, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSessionList, type SessionSummary } from "../hooks/useSessionList";

/**
 * 保存済みセッションの一覧画面。
 * 各行から「ファイルを開く」「フォルダを開く」で OS のデフォルトアプリ / エクスプローラに
 * 解決させる。
 */
export function SessionList() {
  const { data, isLoading, error, refetch } = useSessionList();
  const [actionError, setActionError] = useState<string | null>(null);

  const handleOpenFile = useCallback(async (path: string) => {
    try {
      await openPath(path);
      setActionError(null);
    } catch (e) {
      console.error("ファイルを開けませんでした:", e);
      setActionError(`ファイルを開けませんでした: ${String(e)}`);
    }
  }, []);

  const handleRevealInFolder = useCallback(async (path: string) => {
    try {
      await revealItemInDir(path);
      setActionError(null);
    } catch (e) {
      console.error("フォルダを開けませんでした:", e);
      setActionError(`フォルダを開けませんでした: ${String(e)}`);
    }
  }, []);

  if (isLoading) {
    return <div className="session-list">読み込み中...</div>;
  }

  if (error) {
    return (
      <div className="session-list">
        <p className="session-list-error">
          セッション一覧の取得に失敗しました: {String(error)}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetch()}
        >
          再読み込み
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
        >
          再読み込み
        </button>
      </div>

      {actionError && (
        <p className="session-list-error" role="alert">
          {actionError}
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="session-list-empty">履歴がまだありません</p>
      ) : (
        <ul className="session-list-items">
          {sessions.map((session) => (
            <SessionRow
              key={session.path}
              session={session}
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
  onOpenFile: (path: string) => void;
  onRevealInFolder: (path: string) => void;
}

function SessionRow({ session, onOpenFile, onRevealInFolder }: SessionRowProps) {
  // 秒 → ミリ秒に変換してローカルタイムでフォーマット。
  // タイムゾーンはユーザーの OS 設定に従うため、JST ハードコード（バックエンド表示用）とは独立。
  const startedAtLabel = new Date(session.startedAtSecs * 1000).toLocaleString();

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
          onClick={() => onOpenFile(session.path)}
        >
          ファイルを開く
        </button>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => onRevealInFolder(session.path)}
        >
          フォルダを開く
        </button>
      </div>
    </li>
  );
}
