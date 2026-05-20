import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowLeft, FileText, FolderOpen, Sparkles } from "lucide-react";
import { useSessionContent } from "../hooks/useSessionContent";
import { useSessionList } from "../hooks/useSessionList";
import { parseSessionMarkdown } from "../utils/sessionContentParser";
import {
  getCompactSessionTitle,
  getFileName,
} from "../utils/transcriptViewFormatters";
import { getSessionStartedAtDisplay } from "../utils/sessionListHelpers";
import { toErrorMessage } from "../utils/errorMessage";

type DetailTabKey = "transcript" | "aiMinutes";

interface DetailTabDefinition {
  key: DetailTabKey;
  label: string;
}

const DETAIL_TABS: ReadonlyArray<DetailTabDefinition> = [
  { key: "transcript", label: "文字起こし" },
  { key: "aiMinutes", label: "AI議事録" },
];

/**
 * Mock 2C - Recording Detail に対応する詳細ページ。
 * 保存済みの 1 セッションを「文字起こし」「AI議事録」の 2 タブで提示する。
 * AI議事録タブは現状プレースホルダ（外部 AI 連携を勝手に呼ばない契約のため）。
 */
export function SessionDetail() {
  const { encodedPath } = useParams({ from: "/sessions/$encodedPath" });
  const sessionPath = useMemo(() => {
    try {
      return decodeURIComponent(encodedPath);
    } catch (e) {
      console.error("セッションパスのデコードに失敗しました:", toErrorMessage(e));
      return encodedPath;
    }
  }, [encodedPath]);
  const sessionList = useSessionList();
  const sessionContent = useSessionContent(sessionPath);
  const summary = sessionList.data?.find((s) => s.path === sessionPath) ?? null;
  const parsed = useMemo(() => {
    if (!sessionContent.data?.body) {
      return null;
    }
    return parseSessionMarkdown(sessionContent.data.body);
  }, [sessionContent.data?.body]);
  const [activeTab, setActiveTab] = useState<DetailTabKey>("transcript");
  const [actionError, setActionError] = useState<string | null>(null);

  const handleOpenFile = useCallback(async () => {
    setActionError(null);
    try {
      await openPath(sessionPath);
    } catch (e) {
      setActionError(
        `履歴ファイルを既定アプリで開けませんでした: ${toErrorMessage(e)}`,
      );
    }
  }, [sessionPath]);

  const handleRevealInFolder = useCallback(async () => {
    setActionError(null);
    try {
      await revealItemInDir(sessionPath);
    } catch (e) {
      setActionError(
        `履歴ファイルを Finder で表示できませんでした: ${toErrorMessage(e)}`,
      );
    }
  }, [sessionPath]);

  const fileName = getFileName(sessionPath);
  const displayTitle = summary
    ? getCompactSessionTitle(summary.title)
    : parsed?.titleLine ?? fileName;
  const startedAtDisplay = summary
    ? getSessionStartedAtDisplay(summary.startedAtSecs)
    : null;
  const isLoading = sessionContent.isLoading || sessionList.isLoading;
  const loadError = sessionContent.error ?? null;

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
            <span className="session-detail-file" title={`保存ファイル ${fileName}`}>
              {fileName}
            </span>
          </p>
        )}
      </header>

      <nav className="session-detail-tabs" aria-label="録音詳細タブ">
        {DETAIL_TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              className={
                isActive
                  ? "session-detail-tab session-detail-tab-active"
                  : "session-detail-tab"
              }
              aria-pressed={isActive}
              aria-label={`${tab.label}タブ`}
              title={`${tab.label}タブ`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

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
            aria-label="エラーを閉じる"
          >
            閉じる
          </button>
        </div>
      )}

      <section
        className="session-detail-body"
        aria-busy={isLoading}
        aria-label={
          activeTab === "transcript" ? "文字起こし本文" : "AI議事録プレビュー"
        }
      >
        {isLoading && (
          <p className="session-detail-loading" role="status" aria-live="polite">
            読み込み中...
          </p>
        )}
        {!isLoading && loadError && (
          <p className="session-detail-error" role="alert">
            セッション本文の取得に失敗しました: {toErrorMessage(loadError)}
          </p>
        )}
        {!isLoading && !loadError && activeTab === "transcript" && (
          <TranscriptTimeline parsed={parsed} />
        )}
        {!isLoading && !loadError && activeTab === "aiMinutes" && (
          <AiMinutesPlaceholder />
        )}
      </section>

      <footer
        className="session-detail-actions"
        role="group"
        aria-label="録音詳細アクション"
      >
        <button
          type="button"
          className="control-btn control-btn-transcribe"
          disabled
          aria-disabled="true"
          aria-label="AI議事録を生成（設定でAI連携を有効化すると利用可能）"
          title="設定の AI議事録 タブで連携を有効にすると利用可能になります"
        >
          <Sparkles size={14} aria-hidden="true" />
          AI議事録を生成
        </button>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={handleOpenFile}
          aria-label="履歴ファイルを既定アプリで開く"
          title="既定のテキストアプリで開く"
        >
          <FileText size={14} aria-hidden="true" />
          書き出し
        </button>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={handleRevealInFolder}
          aria-label="履歴ファイルを Finder で表示"
          title="Finder で表示"
        >
          <FolderOpen size={14} aria-hidden="true" />
          Finder で表示
        </button>
      </footer>
    </div>
  );
}

interface TranscriptTimelineProps {
  parsed: ReturnType<typeof parseSessionMarkdown> | null;
}

function TranscriptTimeline({ parsed }: TranscriptTimelineProps) {
  if (!parsed || parsed.segments.length === 0) {
    return (
      <p className="session-detail-empty" role="status">
        この録音にはまだ文字起こしの本文がありません。
      </p>
    );
  }
  return (
    <ol className="session-detail-transcript">
      {parsed.segments.map((segment, index) => (
        <li
          key={`${segment.time}-${index}`}
          className="session-detail-transcript-row"
          aria-label={`${segment.time} ${segment.speaker} ${segment.text}`}
        >
          <span className="session-detail-transcript-time">{segment.time}</span>
          <span className="session-detail-transcript-speaker">
            {segment.speaker}
          </span>
          <span className="session-detail-transcript-text">{segment.text}</span>
        </li>
      ))}
    </ol>
  );
}

function AiMinutesPlaceholder() {
  return (
    <div className="session-detail-ai-placeholder" role="status">
      <Sparkles size={16} aria-hidden="true" />
      <p>
        AI議事録はまだ生成されていません。設定の「AI議事録」タブで連携を有効化すると、
        この録音から要約・決定事項・ToDo を抽出できます。
      </p>
    </div>
  );
}
