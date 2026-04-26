import { useState, useEffect } from "react";
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
  const queryClient = useQueryClient();

  const { data: models, error: modelsError } = useQuery<ModelInfo[]>({
    queryKey: ["models"],
    queryFn: () => invoke<ModelInfo[]>("list_models"),
  });

  // Listen for download progress events
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<DownloadProgressPayload>(
      "model-download-progress",
      (event) => {
        setDownloadProgress(event.payload.progress);
        if (event.payload.progress >= 1) {
          const model = downloadingModel;
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
  }, [downloadingModel, queryClient]);

  // Listen for download error events emitted by the backend.
  // `invoke` の catch でも同じ文字列は拾えるが、長時間 DL 中の切断などは
  // Tauri 側の Err を先に emit で受け取った方が UI 反映が早い。
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<DownloadErrorPayload>(
      "model-download-error",
      (event) => {
        setDownloadError(event.payload.message);
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
    setDownloadingModel(modelName);
    setDownloadProgress(0);
    setDownloadError(null);
    try {
      await invoke("download_model", { modelName });
    } catch (e) {
      // emit 側で既に state を更新している可能性が高いが、
      // emit が届かなかった場合に備えて catch でも冪等に更新する。
      console.error("モデルのダウンロードに失敗しました:", e);
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
      >
        {models?.map((model) => (
          <ModelOption key={model.name} model={model} />
        ))}
      </select>
      {progressListenerError && (
        <span className="download-error" role="alert">
          {progressListenerError}
        </span>
      )}
      {downloadErrorListenerError && (
        <span className="download-error" role="alert">
          {downloadErrorListenerError}
        </span>
      )}
      {modelsError ? (
        <span className="download-error" role="alert">
          モデル一覧の取得に失敗しました: {String(modelsError)}
        </span>
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
  const { data: isDownloaded, error: isDownloadedError } = useQuery<boolean>({
    queryKey: ["modelDownloaded", selectedModel],
    queryFn: () =>
      invoke<boolean>("is_model_downloaded", { modelName: selectedModel }),
    enabled: !!selectedModel,
  });

  if (!selectedModel) return null;

  if (downloadingModel === selectedModel) {
    return (
      <div className="download-progress-wrapper">
        <div className="download-progress-bar">
          <div
            className="download-progress-fill"
            style={{ width: `${Math.round(downloadProgress * 100)}%` }}
          />
        </div>
        <span className="download-progress-text">
          {Math.round(downloadProgress * 100)}%
        </span>
      </div>
    );
  }

  if (isDownloaded) {
    return <span className="model-status-ready">準備完了</span>;
  }

  if (isDownloadedError) {
    return (
      <span className="download-error" role="alert">
        モデル状態の確認に失敗しました: {String(isDownloadedError)}
      </span>
    );
  }

  return (
    <div className="download-status-wrapper">
      <button
        type="button"
        className="download-btn"
        onClick={() => onDownload(selectedModel)}
        disabled={disabled || downloadingModel !== null}
      >
        DL
      </button>
      {downloadError && (
        <span className="download-error" role="alert">
          {downloadError}
        </span>
      )}
    </div>
  );
}
