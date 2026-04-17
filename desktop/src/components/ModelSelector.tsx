import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface ModelInfo {
  name: string;
  displayName: string;
  sizeMb: number;
  url: string;
}

interface DownloadProgressPayload {
  progress: number;
}

interface ModelSelectorProps {
  selectedModel: string;
  onSelectModel: (name: string) => void;
  disabled: boolean;
}

export function ModelSelector({
  selectedModel,
  onSelectModel,
  disabled,
}: ModelSelectorProps) {
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const queryClient = useQueryClient();

  const { data: models } = useQuery<ModelInfo[]>({
    queryKey: ["models"],
    queryFn: () => invoke<ModelInfo[]>("list_models"),
  });

  // Listen for download progress events
  useEffect(() => {
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
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [downloadingModel, queryClient]);

  const handleDownload = async (modelName: string) => {
    setDownloadingModel(modelName);
    setDownloadProgress(0);
    try {
      await invoke("download_model", { modelName });
    } catch (e) {
      console.error("モデルのダウンロードに失敗しました:", e);
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
        disabled={disabled || downloadingModel !== null}
        className="model-select"
      >
        {models?.map((model) => (
          <ModelOption key={model.name} model={model} />
        ))}
      </select>
      <DownloadStatus
        selectedModel={selectedModel}
        downloadingModel={downloadingModel}
        downloadProgress={downloadProgress}
        disabled={disabled}
        onDownload={handleDownload}
      />
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
  disabled: boolean;
  onDownload: (modelName: string) => void;
}

function DownloadStatus({
  selectedModel,
  downloadingModel,
  downloadProgress,
  disabled,
  onDownload,
}: DownloadStatusProps) {
  const { data: isDownloaded } = useQuery<boolean>({
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

  return (
    <button
      type="button"
      className="download-btn"
      onClick={() => onDownload(selectedModel)}
      disabled={disabled || downloadingModel !== null}
    >
      DL
    </button>
  );
}
