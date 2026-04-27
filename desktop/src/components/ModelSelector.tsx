import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ModelInfo,
  DownloadProgressPayload,
  DownloadErrorPayload,
} from "../types";

interface ModelSelectorProps {
  selectedModel: string;
  onSelectModel: (name: string) => void;
  disabled: boolean;
}

function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function sanitizeProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.max(0, Math.min(1, progress));
}

export function ModelSelector({
  selectedModel,
  onSelectModel,
  disabled,
}: ModelSelectorProps) {
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [progressListenerError, setProgressListenerError] = useState<
    string | null
  >(null);
  const [downloadErrorListenerError, setDownloadErrorListenerError] = useState<
    string | null
  >(null);
  const downloadingModelRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    downloadingModelRef.current = downloadingModel;
  }, [downloadingModel]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const {
    data: models,
    error: modelsError,
    isFetching: isFetchingModels,
    refetch: refetchModels,
  } = useQuery<ModelInfo[]>({
    queryKey: ["models"],
    queryFn: () => invoke<ModelInfo[]>("list_models"),
  });
  const modelSelectAriaLabel = modelsError
    ? "Whisperモデル一覧の取得に失敗したため選択できません"
    : downloadingModel
      ? `${downloadingModel} をダウンロード中のためWhisperモデルを選択できません`
      : disabled
        ? "文字起こし中のためWhisperモデルを選択できません"
        : "Whisperモデルを選択";

  // Listen for download progress events
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<DownloadProgressPayload>(
      "model-download-progress",
      (event) => {
        if (disposed) {
          return;
        }
        if (event.payload.model !== downloadingModelRef.current) {
          return;
        }
        const progress = sanitizeProgress(event.payload.progress);
        setDownloadProgress(progress);
        if (progress >= 1) {
          const model = downloadingModelRef.current;
          downloadingModelRef.current = null;
          setDownloadingModel(null);
          setDownloadProgress(0);
          if (model) {
            queryClient.invalidateQueries({
              queryKey: ["modelDownloaded", model],
            });
          }
        }
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setProgressListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("モデルDL進捗通知の受信開始に失敗しました:", msg);
          setProgressListenerError(
            `モデルDL進捗通知の受信開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "モデルDL進捗通知の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, [queryClient]);

  // Listen for download error events emitted by the backend.
  // `invoke` の catch でも同じ文字列は拾えるが、長時間 DL 中の切断などは
  // Tauri 側の Err を先に emit で受け取った方が UI 反映が早い。
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<DownloadErrorPayload>(
      "model-download-error",
      (event) => {
        if (disposed) {
          return;
        }
        setDownloadError(event.payload.message);
        downloadingModelRef.current = null;
        setDownloadingModel(null);
        setDownloadProgress(0);
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setDownloadErrorListenerError(null);
        }
        return unlisten;
      })
      .catch((e) => {
        if (!disposed) {
          const msg = toErrorMessage(e);
          console.error("モデルDLエラー通知の受信開始に失敗しました:", msg);
          setDownloadErrorListenerError(
            `モデルDLエラー通知の受信開始に失敗しました: ${msg}`,
          );
        }
        return null;
      });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten?.())
        .catch((e) => {
          console.error(
            "モデルDLエラー通知の受信解除に失敗しました:",
            toErrorMessage(e),
          );
        });
    };
  }, []);

  const handleDownload = async (modelName: string) => {
    if (downloadingModelRef.current) {
      return;
    }
    downloadingModelRef.current = modelName;
    setDownloadingModel(modelName);
    setDownloadProgress(0);
    setDownloadError(null);
    try {
      await invoke("download_model", { modelName });
      downloadingModelRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      setDownloadingModel(null);
      setDownloadProgress(0);
      queryClient.invalidateQueries({
        queryKey: ["modelDownloaded", modelName],
      });
    } catch (e) {
      // emit 側で既に state を更新している可能性が高いが、
      // emit が届かなかった場合に備えて catch でも冪等に更新する。
      console.error("モデルのダウンロードに失敗しました:", e);
      downloadingModelRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      setDownloadError(typeof e === "string" ? e : String(e));
      setDownloadingModel(null);
      setDownloadProgress(0);
    }
  };

  return (
    <div className="model-selector">
      <label htmlFor="model-select" className="model-select-label">
        モデル:
      </label>
      <select
        id="model-select"
        value={selectedModel}
        onChange={(e) => onSelectModel(e.target.value)}
        disabled={disabled || downloadingModel !== null || Boolean(modelsError)}
        className="model-select"
        aria-label={modelSelectAriaLabel}
        title={modelSelectAriaLabel}
      >
        {models?.map((model) => (
          <ModelOption key={model.name} model={model} />
        ))}
      </select>
      {progressListenerError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`Whisperモデルダウンロード進捗受信エラー: ${progressListenerError}`}
          title={`Whisperモデルダウンロード進捗受信エラー: ${progressListenerError}`}
        >
          {progressListenerError}
        </span>
      )}
      {downloadErrorListenerError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`Whisperモデルダウンロードエラー受信エラー: ${downloadErrorListenerError}`}
          title={`Whisperモデルダウンロードエラー受信エラー: ${downloadErrorListenerError}`}
        >
          {downloadErrorListenerError}
        </span>
      )}
      {modelsError ? (
        <div className="download-status-wrapper">
          <span
            className="download-error"
            role="alert"
            aria-label={`Whisperモデル一覧エラー: ${String(modelsError)}`}
            title={`Whisperモデル一覧エラー: ${String(modelsError)}`}
          >
            モデル一覧の取得に失敗しました: {String(modelsError)}
          </span>
          <button
            type="button"
            className="download-btn"
            onClick={() => refetchModels()}
            disabled={isFetchingModels}
            aria-label={
              isFetchingModels
                ? "Whisperモデル一覧を取得中"
                : "Whisperモデル一覧を再取得"
            }
            title={
              isFetchingModels
                ? "Whisperモデル一覧を取得中"
                : "Whisperモデル一覧を再取得"
            }
          >
            {isFetchingModels ? "取得中..." : "再取得"}
          </button>
        </div>
      ) : (
        <DownloadStatus
          selectedModel={selectedModel}
          downloadingModel={downloadingModel}
          downloadProgress={downloadProgress}
          downloadError={downloadError}
          disabled={disabled}
          onDownload={handleDownload}
        />
      )}
    </div>
  );
}

function ModelOption({ model }: { model: ModelInfo }) {
  return (
    <option value={model.name}>
      {model.displayName} ({model.sizeMb}MB)
    </option>
  );
}

interface DownloadStatusProps {
  selectedModel: string;
  downloadingModel: string | null;
  downloadProgress: number;
  downloadError: string | null;
  disabled: boolean;
  onDownload: (modelName: string) => void;
}

function DownloadStatus({
  selectedModel,
  downloadingModel,
  downloadProgress,
  downloadError,
  disabled,
  onDownload,
}: DownloadStatusProps) {
  const {
    data: isDownloaded,
    error: isDownloadedError,
    isFetching: isFetchingDownloaded,
    refetch: refetchDownloaded,
  } = useQuery<boolean>({
    queryKey: ["modelDownloaded", selectedModel],
    queryFn: () =>
      invoke<boolean>("is_model_downloaded", { modelName: selectedModel }),
    enabled: !!selectedModel,
  });

  if (!selectedModel) return null;

  if (downloadingModel === selectedModel) {
    const progressPercent = Math.round(sanitizeProgress(downloadProgress) * 100);
    const progressLabel = `${selectedModel} モデルダウンロード進捗`;
    return (
      <div className="download-progress-wrapper">
        <div
          className="download-progress-bar"
          role="progressbar"
          aria-label={progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          aria-valuetext={`${progressPercent}%`}
          title={`${progressLabel}: ${progressPercent}%`}
        >
          <div
            className="download-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="download-progress-text">{progressPercent}%</span>
      </div>
    );
  }

  if (isDownloaded) {
    const readyLabel = `${selectedModel} モデルは準備完了`;
    return (
      <span
        className="model-status-ready"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={readyLabel}
        title={readyLabel}
      >
        準備完了
      </span>
    );
  }

  if (isDownloadedError) {
    const downloadedErrorLabel = `${selectedModel} モデル状態エラー: ${String(isDownloadedError)}`;
    const refetchDownloadedLabel = isFetchingDownloaded
      ? `${selectedModel} のモデル状態を確認中`
      : `${selectedModel} のモデル状態を再確認`;
    return (
      <div className="download-status-wrapper">
        <span
          className="download-error"
          role="alert"
          aria-label={downloadedErrorLabel}
          title={downloadedErrorLabel}
        >
          モデル状態の確認に失敗しました: {String(isDownloadedError)}
        </span>
        <button
          type="button"
          className="download-btn"
          aria-label={refetchDownloadedLabel}
          title={refetchDownloadedLabel}
          onClick={() => refetchDownloaded()}
          disabled={isFetchingDownloaded}
        >
          {isFetchingDownloaded ? "確認中..." : "再確認"}
        </button>
      </div>
    );
  }

  const downloadButtonLabel = downloadingModel
    ? `${downloadingModel} をダウンロード中のため ${selectedModel} は待機中`
    : `${selectedModel} をダウンロード`;

  return (
    <div className="download-status-wrapper">
      <button
        type="button"
        className="download-btn"
        aria-label={downloadButtonLabel}
        title={downloadButtonLabel}
        onClick={() => onDownload(selectedModel)}
        disabled={disabled || downloadingModel !== null}
      >
        ダウンロード
      </button>
      {downloadError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`${selectedModel} モデルダウンロードエラー: ${downloadError}`}
          title={`${selectedModel} モデルダウンロードエラー: ${downloadError}`}
        >
          {downloadError}
        </span>
      )}
    </div>
  );
}
