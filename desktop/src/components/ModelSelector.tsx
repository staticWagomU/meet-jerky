import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ModelInfo,
  DownloadProgressPayload,
  DownloadErrorPayload,
} from "../types";
import { toErrorMessage } from "../utils/errorMessage";

interface ModelSelectorProps {
  selectedModel: string;
  onSelectModel: (name: string) => void;
  disabled: boolean;
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
  const [downloadErrorModel, setDownloadErrorModel] = useState<string | null>(
    null,
  );
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
    ? "Whisper モデル一覧の取得に失敗したため選択できません"
    : downloadingModel
      ? `${downloadingModel} をダウンロード中のため Whisper モデルを選択できません。現在の選択: ${selectedModel}`
      : disabled
        ? `文字起こし中のため Whisper モデルを選択できません。現在の選択: ${selectedModel}`
        : `Whisper モデルを選択。現在の選択: ${selectedModel}`;

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
          console.error(
            "Whisper モデルのダウンロード進捗通知の受信開始に失敗しました:",
            msg,
          );
          setProgressListenerError(
            `Whisper モデルのダウンロード進捗通知の受信開始に失敗しました: ${msg}`,
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
            "Whisper モデルのダウンロード進捗通知の受信解除に失敗しました:",
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
        const errorModel = event.payload.model;
        setDownloadError(event.payload.message);
        setDownloadErrorModel(errorModel);
        if (errorModel !== downloadingModelRef.current) {
          return;
        }
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
          console.error(
            "Whisper モデルのダウンロードエラー通知の受信開始に失敗しました:",
            msg,
          );
          setDownloadErrorListenerError(
            `Whisper モデルのダウンロードエラー通知の受信開始に失敗しました: ${msg}`,
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
            "Whisper モデルのダウンロードエラー通知の受信解除に失敗しました:",
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
    setDownloadErrorModel(null);
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
      console.error("Whisper モデルのダウンロードに失敗しました:", e);
      downloadingModelRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      setDownloadError(toErrorMessage(e));
      setDownloadErrorModel(modelName);
      setDownloadingModel(null);
      setDownloadProgress(0);
    }
  };
  const modelsErrorMessage = modelsError ? toErrorMessage(modelsError) : "";
  const modelSelectorLabel = [
    `Whisper モデル選択: ${selectedModel}`,
    isFetchingModels ? "Whisper モデル一覧を取得中" : null,
    downloadingModel ? `${downloadingModel} をダウンロード中` : null,
    modelsError ? `Whisper モデル一覧エラー: ${modelsErrorMessage}` : null,
  ]
    .filter(Boolean)
    .join("、");

  return (
    <div
      className="model-selector"
      aria-busy={isFetchingModels || downloadingModel !== null}
      aria-label={modelSelectorLabel}
      title={modelSelectorLabel}
    >
      <label htmlFor="model-select" className="model-select-label">
        Whisper モデル:
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
          aria-label={`Whisper モデルのダウンロード進捗受信エラー: ${progressListenerError}`}
          title={`Whisper モデルのダウンロード進捗受信エラー: ${progressListenerError}`}
        >
          {progressListenerError}
        </span>
      )}
      {downloadErrorListenerError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`Whisper モデルのダウンロードエラー受信エラー: ${downloadErrorListenerError}`}
          title={`Whisper モデルのダウンロードエラー受信エラー: ${downloadErrorListenerError}`}
        >
          {downloadErrorListenerError}
        </span>
      )}
      {modelsError ? (
        <div className="download-status-wrapper">
          <span
            className="download-error"
            role="alert"
            aria-label={`Whisper モデル一覧エラー: ${modelsErrorMessage}`}
            title={`Whisper モデル一覧エラー: ${modelsErrorMessage}`}
          >
            Whisper モデル一覧の取得に失敗しました: {modelsErrorMessage}
          </span>
          <button
            type="button"
            className="download-btn"
            onClick={() => refetchModels()}
            disabled={isFetchingModels}
            aria-label={
              isFetchingModels
                ? "Whisper モデル一覧を取得中"
                : "Whisper モデル一覧を再取得"
            }
            title={
              isFetchingModels
                ? "Whisper モデル一覧を取得中"
                : "Whisper モデル一覧を再取得"
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
          downloadError={
            downloadErrorModel === selectedModel ? downloadError : null
          }
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
    const progressLabel = `${selectedModel} Whisper モデルのダウンロード進捗`;
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
    const readyLabel = `${selectedModel} Whisper モデルは準備完了`;
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
    const downloadedErrorMessage = toErrorMessage(isDownloadedError);
    const downloadedErrorLabel = `${selectedModel} Whisper モデルの状態の確認エラー: ${downloadedErrorMessage}`;
    const refetchDownloadedLabel = isFetchingDownloaded
      ? `${selectedModel} の Whisper モデルの状態を確認中`
      : `${selectedModel} の Whisper モデルの状態を再確認`;
    return (
      <div className="download-status-wrapper">
        <span
          className="download-error"
          role="alert"
          aria-label={downloadedErrorLabel}
          title={downloadedErrorLabel}
        >
          Whisper モデルの状態の確認に失敗しました: {downloadedErrorMessage}
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

  const downloadButtonLabel = isFetchingDownloaded
    ? `${selectedModel} の Whisper モデルの状態を確認中`
    : downloadingModel
      ? `${downloadingModel} をダウンロード中のため ${selectedModel} は待機中`
      : `${selectedModel} をダウンロード`;

  return (
    <div className="download-status-wrapper" aria-busy={isFetchingDownloaded}>
      <button
        type="button"
        className="download-btn"
        aria-label={downloadButtonLabel}
        title={downloadButtonLabel}
        onClick={() => onDownload(selectedModel)}
        disabled={disabled || downloadingModel !== null || isFetchingDownloaded}
      >
        {isFetchingDownloaded
          ? "確認中..."
          : downloadingModel
            ? "ダウンロード待ち"
            : "ダウンロード"}
      </button>
      {downloadError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`${selectedModel} Whisper モデルのダウンロードエラー: ${downloadError}`}
          title={`${selectedModel} Whisper モデルのダウンロードエラー: ${downloadError}`}
        >
          {downloadError}
        </span>
      )}
    </div>
  );
}
