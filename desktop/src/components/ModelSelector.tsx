import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelInfo } from "../types";
import { toErrorMessage } from "../utils/errorMessage";
import {
  getModelDisplayName,
  getWhisperModelLabel,
  sanitizeProgress,
} from "../utils/modelSelectorHelpers";
import {
  getDownloadErrorPayloadIssue,
  getDownloadProgressPayloadIssue,
  isDownloadErrorPayload,
  isDownloadProgressPayload,
  MODEL_DOWNLOAD_ERROR_EVENT,
  MODEL_DOWNLOAD_PROGRESS_EVENT,
} from "../utils/modelDownloadPayload";
import { isTauriRuntime } from "../utils/browserRuntime";
import {
  isPreviewModelDownloaded,
  PREVIEW_MODELS,
} from "../utils/previewAppData";

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
  const isBrowserPreview = !isTauriRuntime();
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
    queryKey: ["models", isBrowserPreview ? "browser-preview" : "tauri"],
    queryFn: () =>
      isBrowserPreview
        ? Promise.resolve(PREVIEW_MODELS)
        : invoke<ModelInfo[]>("list_models"),
  });
  const selectedModelLabel = getModelDisplayName(models, selectedModel);
  const downloadingModelLabel = getModelDisplayName(models, downloadingModel);
  const selectedModelStatusLabel = selectedModelLabel ?? "未選択";
  const selectedModelInfo = models?.find(
    (model) => model.name === selectedModel,
  );
  const selectedModelSizeLabel = selectedModelInfo
    ? `${selectedModelInfo.sizeMb}MB`
    : "サイズ未確認";
  const modelSelectAriaLabel = modelsError
    ? "モデル一覧を取得できません"
    : downloadingModel
      ? `ダウンロード中。選択中 ${selectedModelStatusLabel}`
      : disabled
        ? `録音中。選択中 ${selectedModelStatusLabel}`
        : `モデル選択。現在 ${selectedModelStatusLabel}`;

  // Listen for download progress events
  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    let disposed = false;
    const unlistenPromise = listen<unknown>(
      MODEL_DOWNLOAD_PROGRESS_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isDownloadProgressPayload(payload)) {
          console.error(
            "Whisper モデルのダウンロード進捗通知の形式が不正です:",
            getDownloadProgressPayloadIssue(payload),
          );
          setProgressListenerError("ダウンロード状況を確認できませんでした");
          return;
        }
        setProgressListenerError(null);
        if (payload.model !== downloadingModelRef.current) {
          return;
        }
        const progress = sanitizeProgress(payload.progress);
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
          setProgressListenerError("ダウンロード状況を確認できませんでした");
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
  }, [isBrowserPreview, queryClient]);

  // Listen for download error events emitted by the backend.
  // `invoke` の catch でも同じ文字列は拾えるが、長時間 DL 中の切断などは
  // Tauri 側の Err を先に emit で受け取った方が UI 反映が早い。
  useEffect(() => {
    if (isBrowserPreview) {
      return;
    }
    let disposed = false;
    const unlistenPromise = listen<unknown>(
      MODEL_DOWNLOAD_ERROR_EVENT,
      (event) => {
        if (disposed) {
          return;
        }
        const payload = event.payload;
        if (!isDownloadErrorPayload(payload)) {
          console.error(
            "Whisper モデルのダウンロードエラー通知の形式が不正です:",
            getDownloadErrorPayloadIssue(payload),
          );
          setDownloadErrorListenerError(
            "ダウンロード結果を確認できませんでした",
          );
          return;
        }
        setDownloadErrorListenerError(null);
        const errorModel = payload.model;
        setDownloadError(payload.message);
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
            "ダウンロード結果を確認できませんでした",
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
  }, [isBrowserPreview]);

  const handleDownload = async (modelName: string) => {
    if (downloadingModelRef.current) {
      return;
    }
    downloadingModelRef.current = modelName;
    setDownloadingModel(modelName);
    setDownloadProgress(0);
    setDownloadError(null);
    setDownloadErrorModel(null);
    if (isBrowserPreview) {
      window.setTimeout(() => {
        downloadingModelRef.current = null;
        if (!isMountedRef.current) {
          return;
        }
        setDownloadingModel(null);
        setDownloadProgress(0);
        queryClient.invalidateQueries({
          queryKey: ["modelDownloaded", modelName],
        });
      }, 180);
      return;
    }
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
    `モデル: ${selectedModelStatusLabel}`,
    isFetchingModels ? "一覧取得中" : null,
    downloadingModel ? `${downloadingModelLabel} をダウンロード中` : null,
    modelsError ? "一覧取得不可" : null,
  ]
    .filter(Boolean)
    .join("、");
  const modelBoundaryItems = [
    {
      label: "モデル",
      value: selectedModelStatusLabel,
      detail: selectedModelSizeLabel,
      tone: selectedModelInfo ? "ready" : "muted",
    },
    {
      label: "処理",
      value: "端末内",
      detail: "Whisper",
      tone: "ready",
    },
    {
      label: "音声外部送信",
      value: "外部送信なし",
      detail: "音声トラック",
      tone: "ready",
    },
  ] as const;

  return (
    <div
      className="model-selector"
      aria-busy={isFetchingModels || downloadingModel !== null}
      aria-label={modelSelectorLabel}
      title={modelSelectorLabel}
    >
      <div className="model-selector-header">
        <div className="model-selector-heading">
          <span>文字起こしモデル</span>
          <label htmlFor="model-select" className="model-select-label">
            Whisper モデル
          </label>
        </div>
        <select
          id="model-select"
          value={selectedModel}
          onChange={(e) => onSelectModel(e.target.value)}
          disabled={
            disabled || downloadingModel !== null || Boolean(modelsError)
          }
          className="model-select"
          aria-label={modelSelectAriaLabel}
          title={modelSelectAriaLabel}
        >
          {models?.map((model) => (
            <ModelOption key={model.name} model={model} />
          ))}
        </select>
      </div>
      <div
        className="model-boundary-grid"
        aria-label={`モデル ${selectedModelStatusLabel}、端末内、音声は外部送信しません`}
      >
        {modelBoundaryItems.map((item) => (
          <span
            key={item.label}
            className={`model-boundary-item model-boundary-item-${item.tone}`}
          >
            <strong>{item.label}</strong>
            <small>{item.value}</small>
            <em>{item.detail}</em>
          </span>
        ))}
      </div>
      {progressListenerError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`モデル取得エラー: ${progressListenerError}`}
          title={`モデル取得エラー: ${progressListenerError}`}
        >
          {progressListenerError}
        </span>
      )}
      {downloadErrorListenerError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`モデル取得エラー: ${downloadErrorListenerError}`}
          title={`モデル取得エラー: ${downloadErrorListenerError}`}
        >
          {downloadErrorListenerError}
        </span>
      )}
      {modelsError ? (
        <div className="download-status-wrapper">
          <span
            className="download-error"
            role="alert"
            aria-label="Whisper モデル一覧を取得できません"
            title={modelsErrorMessage}
          >
            モデル一覧を取得できません。
          </span>
          <button
            type="button"
            className="download-btn"
            onClick={() => refetchModels()}
            disabled={isFetchingModels}
            aria-label={
              isFetchingModels ? "モデル一覧を取得中" : "モデル一覧を再取得"
            }
            title={
              isFetchingModels ? "モデル一覧を取得中" : "モデル一覧を再取得"
            }
          >
            {isFetchingModels ? "モデル一覧取得中…" : "モデル一覧再取得"}
          </button>
        </div>
      ) : (
        <DownloadStatus
          selectedModel={selectedModel}
          selectedModelLabel={selectedModelLabel}
          downloadingModel={downloadingModel}
          downloadingModelLabel={downloadingModelLabel}
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
      {getWhisperModelLabel(model)} ({model.sizeMb}MB)
    </option>
  );
}

interface DownloadStatusProps {
  selectedModel: string;
  selectedModelLabel: string | null;
  downloadingModel: string | null;
  downloadingModelLabel: string | null;
  downloadProgress: number;
  downloadError: string | null;
  disabled: boolean;
  onDownload: (modelName: string) => void;
}

function DownloadStatus({
  selectedModel,
  selectedModelLabel,
  downloadingModel,
  downloadingModelLabel,
  downloadProgress,
  downloadError,
  disabled,
  onDownload,
}: DownloadStatusProps) {
  const isBrowserPreview = !isTauriRuntime();
  const {
    data: isDownloaded,
    error: isDownloadedError,
    isFetching: isFetchingDownloaded,
    refetch: refetchDownloaded,
  } = useQuery<boolean>({
    queryKey: [
      "modelDownloaded",
      selectedModel,
      isBrowserPreview ? "browser-preview" : "tauri",
    ],
    queryFn: () =>
      isBrowserPreview
        ? Promise.resolve(isPreviewModelDownloaded(selectedModel))
        : invoke<boolean>("is_model_downloaded", { modelName: selectedModel }),
    enabled: !!selectedModel,
  });

  if (!selectedModel) return null;

  const selectedLabel = selectedModelLabel ?? selectedModel;
  const downloadingLabel = downloadingModelLabel ?? downloadingModel;

  if (downloadingModel === selectedModel) {
    const progressPercent = Math.round(
      sanitizeProgress(downloadProgress) * 100,
    );
    const progressLabel = `${selectedLabel} ダウンロード`;
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
    const readyLabel = `${selectedLabel} 準備完了`;
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
    const downloadedErrorLabel = `${selectedLabel} を確認できません`;
    const refetchDownloadedLabel = isFetchingDownloaded
      ? `${selectedLabel} を確認中`
      : `${selectedLabel} を再確認`;
    return (
      <div className="download-status-wrapper">
        <span
          className="download-error"
          role="alert"
          aria-label={downloadedErrorLabel}
          title={downloadedErrorMessage}
        >
          モデルを確認できません。
        </span>
        <button
          type="button"
          className="download-btn"
          aria-label={refetchDownloadedLabel}
          title={refetchDownloadedLabel}
          onClick={() => refetchDownloaded()}
          disabled={isFetchingDownloaded}
        >
          {isFetchingDownloaded ? "モデル確認中…" : "モデル再確認"}
        </button>
      </div>
    );
  }

  const downloadButtonLabel = isFetchingDownloaded
    ? `${selectedLabel} を確認中`
    : downloadingModel
      ? `${downloadingLabel} をダウンロード中`
      : `${selectedLabel} をダウンロード`;

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
          ? "モデル確認中…"
          : downloadingModel
            ? "モデル待機"
            : "モデルダウンロード"}
      </button>
      {downloadError && (
        <span
          className="download-error"
          role="alert"
          aria-label={`${selectedLabel} をダウンロードできません`}
          title={downloadError}
        >
          ダウンロードできません。
        </span>
      )}
    </div>
  );
}
