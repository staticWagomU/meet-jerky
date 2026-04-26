import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppSettings, AudioDevice, TranscriptionEngineType } from "../types";
import { usePermissions } from "../hooks/usePermissions";

const WHISPER_MODELS = [
  { value: "tiny", label: "Tiny" },
  { value: "base", label: "Base" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large-v3", label: "Large v3" },
];

const LANGUAGES = [
  { value: "auto", label: "自動検出" },
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

export function SettingsView() {
  const queryClient = useQueryClient();
  const [localSettings, setLocalSettings] = useState<AppSettings | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const lastSyncedSettingsRef = useRef<AppSettings | null>(null);
  const isSavingSettingsRef = useRef(false);
  const [isSelectingOutputDirectory, setIsSelectingOutputDirectory] =
    useState(false);
  const isSelectingOutputDirectoryRef = useRef(false);

  const {
    data: settings,
    error: settingsError,
    isLoading: isLoadingSettings,
    isFetching: isFetchingSettings,
    refetch: refetchSettings,
  } = useQuery<AppSettings>({
    queryKey: ["settings"],
    queryFn: () => invoke<AppSettings>("get_settings"),
  });

  const {
    data: devices,
    error: devicesError,
    isFetching: isFetchingDevices,
    refetch: refetchDevices,
  } = useQuery<AudioDevice[]>({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<AudioDevice[]>("list_audio_devices"),
  });

  const {
    data: defaultOutputDir,
    error: defaultOutputDirError,
    isFetching: isFetchingDefaultOutputDir,
    refetch: refetchDefaultOutputDir,
  } = useQuery<string>({
    queryKey: ["defaultOutputDirectory"],
    queryFn: () => invoke<string>("get_default_output_directory"),
  });

  const {
    micPermission,
    micPermissionError,
    isFetchingMicPermission,
    screenPermission,
    screenPermissionError,
    isFetchingScreenPermission,
    isCheckingPermissions,
    refetchAll: refetchPermissions,
  } = usePermissions();

  const updateMutation = useMutation({
    mutationFn: (newSettings: AppSettings) =>
      invoke("update_settings", { settings: newSettings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      showToast("設定を保存しました");
    },
    onError: (error) => {
      showToast(`保存に失敗しました: ${error}`);
    },
    onSettled: () => {
      isSavingSettingsRef.current = false;
    },
  });

  useEffect(() => {
    if (!settings) {
      return;
    }
    setLocalSettings((current) => {
      const previous = lastSyncedSettingsRef.current;
      const hasUnsavedChanges =
        current !== null &&
        previous !== null &&
        JSON.stringify(current) !== JSON.stringify(previous);
      lastSyncedSettingsRef.current = settings;
      if (hasUnsavedChanges) {
        return current;
      }
      return settings;
    });
  }, [settings]);

  const showToast = useCallback((message: string) => {
    if (!isMountedRef.current) {
      return;
    }
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToastMessage(message);
    toastTimeoutRef.current = setTimeout(() => {
      if (!isMountedRef.current) {
        return;
      }
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    };
  }, []);

  const handleSave = useCallback(() => {
    if (updateMutation.isPending || isSavingSettingsRef.current) {
      return;
    }
    if (localSettings) {
      isSavingSettingsRef.current = true;
      updateMutation.mutate(localSettings);
    }
  }, [localSettings, updateMutation]);

  const handleSelectOutputDirectory = useCallback(async () => {
    if (isSelectingOutputDirectory || isSelectingOutputDirectoryRef.current) {
      return;
    }
    isSelectingOutputDirectoryRef.current = true;
    setIsSelectingOutputDirectory(true);
    try {
      const selected = await invoke<string | null>("select_output_directory");
      if (selected && localSettings) {
        setLocalSettings({ ...localSettings, outputDirectory: selected });
      }
    } catch (e) {
      console.error("フォルダ選択に失敗しました:", e);
      showToast(`フォルダ選択に失敗しました: ${String(e)}`);
    } finally {
      isSelectingOutputDirectoryRef.current = false;
      setIsSelectingOutputDirectory(false);
    }
  }, [isSelectingOutputDirectory, localSettings, showToast]);

  const handleResetOutputDirectory = useCallback(() => {
    if (localSettings) {
      setLocalSettings({ ...localSettings, outputDirectory: null });
    }
  }, [localSettings]);

  if (settingsError) {
    return (
      <div className="settings-view">
        <p className="settings-warning" role="alert">
          設定の読み込みに失敗しました: {String(settingsError)}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetchSettings()}
          disabled={isFetchingSettings}
          aria-label={
            isFetchingSettings
              ? "アプリ設定を読み込み中"
              : "アプリ設定を再読み込み"
          }
        >
          {isFetchingSettings ? "読み込み中..." : "再読み込み"}
        </button>
      </div>
    );
  }

  if (isLoadingSettings || !localSettings) {
    return (
      <div className="settings-view" role="status">
        読み込み中...
      </div>
    );
  }

  const hasChanges = JSON.stringify(localSettings) !== JSON.stringify(settings);

  return (
    <div className="settings-view">
      {/* 文字起こしエンジン */}
      <div className="settings-section">
        <h3 className="settings-section-title" id="transcription-engine-title">
          文字起こしエンジン
        </h3>
        <div
          className="settings-radio-group"
          role="radiogroup"
          aria-labelledby="transcription-engine-title"
        >
          <label className="settings-radio-label">
            <input
              type="radio"
              name="engine"
              value="whisper"
              checked={localSettings.transcriptionEngine === "whisper"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "whisper" as TranscriptionEngineType,
                })
              }
            />
            <span>ローカル (Whisper)</span>
            <span className="settings-note">端末内処理</span>
          </label>
          <label className="settings-radio-label">
            <input
              type="radio"
              name="engine"
              value="appleSpeech"
              checked={localSettings.transcriptionEngine === "appleSpeech"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "appleSpeech" as TranscriptionEngineType,
                })
              }
            />
            <span>macOS SpeechAnalyzer</span>
            <span className="settings-note">端末内処理 / macOS 26+ 専用</span>
          </label>
          <label className="settings-radio-label">
            <input
              type="radio"
              name="engine"
              value="openAIRealtime"
              checked={localSettings.transcriptionEngine === "openAIRealtime"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "openAIRealtime" as TranscriptionEngineType,
                })
              }
            />
            <span>OpenAI Realtime API</span>
            <span className="settings-note">音声をOpenAIへ送信 / API キーが必要</span>
          </label>
        </div>
      </div>

      {/* OpenAI API キー (Realtime) */}
      {localSettings.transcriptionEngine === "openAIRealtime" && (
        <OpenAIApiKeySection showToast={showToast} />
      )}

      {/* Whisperモデル */}
      {localSettings.transcriptionEngine === "whisper" && (
        <div className="settings-section">
          <h3 className="settings-section-title">Whisperモデル</h3>
          <select
            aria-label="Whisperモデル"
            value={localSettings.whisperModel}
            onChange={(e) =>
              setLocalSettings({ ...localSettings, whisperModel: e.target.value })
            }
            className="settings-select"
          >
            {WHISPER_MODELS.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* マイクデバイス */}
      <div className="settings-section">
        <h3 className="settings-section-title">マイクデバイス</h3>
        <select
          aria-label="マイクデバイス"
          value={localSettings.microphoneDeviceId ?? ""}
          onChange={(e) =>
            setLocalSettings({
              ...localSettings,
              microphoneDeviceId: e.target.value || null,
            })
          }
          className="settings-select"
        >
          <option value="">デフォルト</option>
          {devices?.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
        {devicesError && (
          <div className="settings-inline-error" role="alert">
            <span>マイクデバイス一覧の取得に失敗しました: {String(devicesError)}</span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchDevices()}
              disabled={isFetchingDevices}
              aria-label={
                isFetchingDevices
                  ? "マイクデバイス一覧を取得中"
                  : "マイクデバイス一覧を再取得"
              }
            >
              {isFetchingDevices ? "取得中..." : "再取得"}
            </button>
          </div>
        )}
      </div>

      {/* 言語 */}
      <div className="settings-section">
        <h3 className="settings-section-title">言語</h3>
        <select
          aria-label="言語"
          value={localSettings.language}
          onChange={(e) =>
            setLocalSettings({ ...localSettings, language: e.target.value })
          }
          className="settings-select"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      {/* 出力先ディレクトリ */}
      <div className="settings-section">
        <h3 className="settings-section-title">出力先ディレクトリ</h3>
        <div className="settings-output-dir">
          <span className="settings-output-path" role="status">
            {localSettings.outputDirectory ?? defaultOutputDir ?? "未設定"}
          </span>
          {defaultOutputDirError && !localSettings.outputDirectory && (
            <div className="settings-inline-error" role="alert">
              <span>
                デフォルト出力先の取得に失敗しました: {String(defaultOutputDirError)}
              </span>
              <button
                type="button"
                className="control-btn control-btn-clear"
                onClick={() => refetchDefaultOutputDir()}
                disabled={isFetchingDefaultOutputDir}
                aria-label={
                  isFetchingDefaultOutputDir
                    ? "デフォルト出力先ディレクトリを取得中"
                    : "デフォルト出力先ディレクトリを再取得"
                }
              >
                {isFetchingDefaultOutputDir ? "取得中..." : "再取得"}
              </button>
            </div>
          )}
          <div className="settings-output-actions">
            <button
              type="button"
              className="control-btn control-btn-transcribe"
              onClick={handleSelectOutputDirectory}
              disabled={isSelectingOutputDirectory}
              aria-label={
                isSelectingOutputDirectory
                  ? "出力先ディレクトリを選択中"
                  : "出力先ディレクトリを選択"
              }
            >
              {isSelectingOutputDirectory ? "選択中..." : "フォルダ選択"}
            </button>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={handleResetOutputDirectory}
              disabled={isSelectingOutputDirectory || !localSettings.outputDirectory}
              aria-label={
                isSelectingOutputDirectory
                  ? "出力先ディレクトリを選択中"
                  : localSettings.outputDirectory
                    ? "出力先ディレクトリをデフォルトに戻す"
                    : "出力先ディレクトリはデフォルトです"
              }
            >
              デフォルトに戻す
            </button>
          </div>
        </div>
      </div>

      {/* 権限ステータス */}
      <div className="settings-section">
        <h3 className="settings-section-title">権限ステータス</h3>
        <div className="settings-permissions">
          <div className="settings-permission-row">
            <span className="settings-permission-label">
              マイク <span className="settings-permission-track">自分</span>
            </span>
            <PermissionBadge
              label="マイク 自分トラック"
              status={micPermission}
              error={micPermissionError}
              isChecking={isFetchingMicPermission}
            />
          </div>
          <div className="settings-permission-row">
            <span className="settings-permission-label">
              画面収録{" "}
              <span className="settings-permission-track">相手側</span>
            </span>
            <PermissionBadge
              label="画面収録 相手側トラック"
              status={screenPermission}
              error={screenPermissionError}
              isChecking={isFetchingScreenPermission}
            />
          </div>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={refetchPermissions}
            disabled={isCheckingPermissions}
            aria-label={
              isCheckingPermissions
                ? "macOS権限状態を確認中"
                : "macOS権限状態を再チェック"
            }
          >
            {isCheckingPermissions ? "確認中..." : "再チェック"}
          </button>
          {(Boolean(micPermissionError) || Boolean(screenPermissionError)) && (
            <p className="settings-note">
              macOS の権限状態を読み取れませんでした。録音や相手側音声取得の可否が不明なため、システム設定のプライバシーとセキュリティでマイクと画面収録を確認してください。
            </p>
          )}
        </div>
      </div>

      {/* 保存ボタン */}
      <div className="settings-actions">
        {hasChanges && (
          <span className="settings-unsaved-status" role="status">
            未保存の変更があります
          </span>
        )}
        <button
          type="button"
          className="control-btn control-btn-transcribe settings-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || updateMutation.isPending}
          aria-label={
            updateMutation.isPending
              ? "設定を保存中"
              : hasChanges
                ? "変更した設定を保存"
                : "保存する設定変更はありません"
          }
        >
          {updateMutation.isPending ? "保存中..." : "設定を保存"}
        </button>
      </div>

      {/* トースト通知 */}
      {toastMessage && (
        <div
          className="toast"
          role="status"
          aria-live="polite"
          aria-label={`設定通知: ${toastMessage}`}
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}

function PermissionBadge({
  label,
  status,
  error,
  isChecking,
}: {
  label: string;
  status: string | undefined;
  error: unknown;
  isChecking: boolean;
}) {
  const renderBadge = (className: string, text: string) => (
    <span
      className={`settings-permission-badge${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={`${label}: ${text}`}
    >
      {text}
    </span>
  );

  if (isChecking) {
    return renderBadge("", "確認中...");
  }
  if (error) {
    return renderBadge("permission-denied", "確認失敗");
  }
  if (!status) {
    return renderBadge("", "確認中...");
  }
  if (status === "granted") {
    return renderBadge("permission-granted", "許可済み");
  }
  if (status === "denied") {
    return renderBadge("permission-denied", "拒否");
  }
  return renderBadge("permission-undetermined", "未確認");
}

function OpenAIApiKeySection({
  showToast,
}: {
  showToast: (msg: string) => void;
}) {
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const isSettingApiKeyRef = useRef(false);
  const isClearingApiKeyRef = useRef(false);

  const {
    data: hasKey,
    error: hasKeyError,
    isFetching: isFetchingHasKey,
    refetch: refetchHasKey,
  } = useQuery<boolean>({
    queryKey: ["openaiApiKey", "has"],
    queryFn: () => invoke<boolean>("has_openai_api_key"),
  });

  const setMutation = useMutation({
    mutationFn: (apiKey: string) => invoke("set_openai_api_key", { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openaiApiKey", "has"] });
      setKeyInput("");
      showToast("API キーを保存しました");
    },
    onError: (e) => showToast(`API キーの保存に失敗しました: ${e}`),
    onSettled: () => {
      isSettingApiKeyRef.current = false;
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => invoke("clear_openai_api_key"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openaiApiKey", "has"] });
      showToast("API キーを削除しました");
    },
    onError: (e) => showToast(`API キーの削除に失敗しました: ${e}`),
    onSettled: () => {
      isClearingApiKeyRef.current = false;
    },
  });

  const handleSetApiKey = useCallback(() => {
    if (setMutation.isPending || isSettingApiKeyRef.current) {
      return;
    }
    const apiKey = keyInput.trim();
    if (!apiKey) {
      return;
    }
    isSettingApiKeyRef.current = true;
    setMutation.mutate(apiKey);
  }, [keyInput, setMutation]);

  const handleClearApiKey = useCallback(() => {
    if (
      clearMutation.isPending ||
      isClearingApiKeyRef.current ||
      isFetchingHasKey ||
      !hasKey ||
      Boolean(hasKeyError)
    ) {
      return;
    }
    isClearingApiKeyRef.current = true;
    clearMutation.mutate();
  }, [clearMutation, hasKey, hasKeyError, isFetchingHasKey]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">OpenAI API キー</h3>
      <p className="settings-note">
        Keychain に安全に保存され、ブラウザ・ログには出力されません。
      </p>
      <div className="settings-api-key">
        {hasKeyError && (
          <div className="settings-inline-error" role="alert">
            <span>
              API キー状態の確認に失敗しました: {String(hasKeyError)}
            </span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchHasKey()}
              disabled={isFetchingHasKey}
              aria-label={
                isFetchingHasKey
                  ? "OpenAI API キー状態を確認中"
                  : "OpenAI API キー状態を再確認"
              }
            >
              {isFetchingHasKey ? "確認中..." : "再確認"}
            </button>
          </div>
        )}
        <input
          type="password"
          aria-label="OpenAI API キー"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? "登録済み (再入力で上書き)" : "sk-..."}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          className="settings-input"
        />
        <div className="settings-api-key-actions">
          <button
            type="button"
            className="control-btn control-btn-transcribe"
            disabled={!keyInput.trim() || setMutation.isPending}
            onClick={handleSetApiKey}
            aria-label={
              setMutation.isPending
                ? "OpenAI API キーを保存中"
                : keyInput.trim()
                  ? "OpenAI API キーを保存"
                  : "OpenAI API キーを入力すると保存できます"
            }
          >
            {setMutation.isPending ? "保存中..." : "保存"}
          </button>
          <button
            type="button"
            className="control-btn control-btn-clear"
            disabled={
              !hasKey ||
              Boolean(hasKeyError) ||
              isFetchingHasKey ||
              clearMutation.isPending
            }
            onClick={handleClearApiKey}
            aria-label={
              clearMutation.isPending
                ? "OpenAI API キーを削除中"
                : isFetchingHasKey
                  ? "OpenAI API キー状態を確認中"
                  : hasKeyError
                    ? "OpenAI API キー状態を確認できないため削除できません"
                    : hasKey
                      ? "OpenAI API キーを削除"
                      : "削除できる OpenAI API キーはありません"
            }
          >
            {clearMutation.isPending ? "削除中..." : "削除"}
          </button>
        </div>
        <div
          className="settings-api-key-status"
          role="status"
          aria-live="polite"
          aria-label={`OpenAI API キー状態: ${
            isFetchingHasKey
              ? "確認中"
              : hasKeyError
                ? "確認失敗"
                : hasKey === undefined
                  ? "確認中"
                  : hasKey
                    ? "登録済み"
                    : "未登録"
          }`}
        >
          状態:{" "}
          {isFetchingHasKey
            ? "確認中..."
            : hasKeyError
              ? "確認失敗"
              : hasKey === undefined
                ? "確認中..."
              : hasKey
                ? "登録済み"
                : "未登録"}
        </div>
      </div>
    </div>
  );
}
