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

const OPENAI_API_KEY_NOTE_ID = "openai-api-key-note";
const ENGINE_NOTE_IDS = {
  whisper: "transcription-engine-note-whisper",
  appleSpeech: "transcription-engine-note-apple-speech",
  openAIRealtime: "transcription-engine-note-openai-realtime",
} as const;

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
    const reloadSettingsLabel = isFetchingSettings
      ? "アプリ設定を読み込み中"
      : "アプリ設定を再読み込み";
    return (
      <div className="settings-view">
        <p
          className="settings-warning"
          role="alert"
          aria-label={`アプリ設定読み込みエラー: ${String(settingsError)}`}
          title={`アプリ設定読み込みエラー: ${String(settingsError)}`}
        >
          設定の読み込みに失敗しました: {String(settingsError)}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetchSettings()}
          disabled={isFetchingSettings}
          aria-label={reloadSettingsLabel}
          title={reloadSettingsLabel}
        >
          {isFetchingSettings ? "読み込み中..." : "再読み込み"}
        </button>
      </div>
    );
  }

  if (isLoadingSettings || !localSettings) {
    const loadingSettingsLabel = "アプリ設定を読み込み中";
    return (
      <div
        className="settings-view"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={loadingSettingsLabel}
        title={loadingSettingsLabel}
      >
        読み込み中...
      </div>
    );
  }

  const hasChanges = JSON.stringify(localSettings) !== JSON.stringify(settings);
  const outputDirectoryDisplayText =
    localSettings.outputDirectory ??
    defaultOutputDir ??
    (isFetchingDefaultOutputDir ? "取得中..." : "未設定");
  const outputDirectoryLabel = localSettings.outputDirectory
    ? `現在の出力先ディレクトリ: ${localSettings.outputDirectory}`
    : defaultOutputDir
      ? `現在の出力先ディレクトリはデフォルトです: ${defaultOutputDir}`
      : isFetchingDefaultOutputDir
        ? "現在の出力先ディレクトリを取得中です"
      : "現在の出力先ディレクトリは未設定です";
  const outputDirectoryModeLabel = localSettings.outputDirectory
    ? "カスタム"
    : "デフォルト";
  const selectOutputDirectoryLabel = isSelectingOutputDirectory
    ? "出力先ディレクトリを選択中"
    : "出力先ディレクトリを選択";
  const resetOutputDirectoryLabel = isSelectingOutputDirectory
    ? "出力先ディレクトリを選択中"
    : localSettings.outputDirectory
      ? "出力先ディレクトリをデフォルトに戻す"
      : "出力先ディレクトリはデフォルトです";
  const whisperModelName =
    WHISPER_MODELS.find((model) => model.value === localSettings.whisperModel)
      ?.label ?? localSettings.whisperModel;
  const selectedMicrophoneDeviceName = localSettings.microphoneDeviceId
    ? (devices?.find((device) => device.id === localSettings.microphoneDeviceId)
        ?.name ?? localSettings.microphoneDeviceId)
    : "デフォルト";
  const languageName =
    LANGUAGES.find((lang) => lang.value === localSettings.language)?.label ??
    localSettings.language;
  const whisperModelLabel = `Whisperモデル: ${whisperModelName}`;
  const microphoneDeviceLabel = localSettings.microphoneDeviceId
    ? `マイクデバイス: ${selectedMicrophoneDeviceName}`
    : "マイクデバイス: デフォルト";
  const retryDevicesLabel = isFetchingDevices
    ? "マイクデバイス一覧を取得中"
    : "マイクデバイス一覧を再取得";
  const languageLabel = `言語: ${languageName}`;
  const retryDefaultOutputDirLabel = isFetchingDefaultOutputDir
    ? "デフォルト出力先ディレクトリを取得中"
    : "デフォルト出力先ディレクトリを再取得";
  const permissionRetryLabel = isCheckingPermissions
    ? "macOS権限状態を確認中"
    : "macOS権限状態を再チェック";
  const hasPermissionCheckError =
    Boolean(micPermissionError) || Boolean(screenPermissionError);
  const hasPermissionStatusAttention =
    !isCheckingPermissions &&
    (hasPermissionCheckError ||
      micPermission === "denied" ||
      micPermission === "undetermined" ||
      screenPermission === "denied" ||
      screenPermission === "undetermined");
  const permissionStatusNote = hasPermissionCheckError
    ? "macOS の権限状態を読み取れませんでした。録音や相手側音声取得の可否が不明なため、システム設定のプライバシーとセキュリティでマイクと画面収録を確認してください。"
    : "拒否または未確認の権限がある場合は、システム設定のプライバシーとセキュリティでマイクと画面収録を確認してください。";
  const unsavedSettingsLabel = "未保存の変更があります";
  const saveSettingsLabel = updateMutation.isPending
    ? "設定を保存中"
    : hasChanges
      ? "変更した設定を保存"
      : "保存する設定変更はありません";
  const whisperEngineLabel = "文字起こしエンジン: ローカル Whisper、端末内処理";
  const appleSpeechEngineLabel =
    "文字起こしエンジン: macOS SpeechAnalyzer、端末内処理";
  const openAIRealtimeEngineLabel =
    "文字起こしエンジン: OpenAI Realtime API、音声をOpenAIへ送信";
  const isSettingsViewBusy =
    updateMutation.isPending ||
    isSelectingOutputDirectory ||
    isFetchingSettings ||
    isFetchingDevices ||
    isFetchingDefaultOutputDir ||
    isCheckingPermissions;

  return (
    <div className="settings-view" aria-busy={isSettingsViewBusy}>
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
          <label className="settings-radio-label" title={whisperEngineLabel}>
            <input
              type="radio"
              name="engine"
              value="whisper"
              aria-describedby={ENGINE_NOTE_IDS.whisper}
              checked={localSettings.transcriptionEngine === "whisper"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "whisper" as TranscriptionEngineType,
                })
              }
            />
            <span>ローカル (Whisper)</span>
            <span id={ENGINE_NOTE_IDS.whisper} className="settings-note">
              端末内処理
            </span>
          </label>
          <label className="settings-radio-label" title={appleSpeechEngineLabel}>
            <input
              type="radio"
              name="engine"
              value="appleSpeech"
              aria-describedby={ENGINE_NOTE_IDS.appleSpeech}
              checked={localSettings.transcriptionEngine === "appleSpeech"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "appleSpeech" as TranscriptionEngineType,
                })
              }
            />
            <span>macOS SpeechAnalyzer</span>
            <span id={ENGINE_NOTE_IDS.appleSpeech} className="settings-note">
              端末内処理 / macOS 26+ 専用
            </span>
          </label>
          <label
            className="settings-radio-label"
            title={openAIRealtimeEngineLabel}
          >
            <input
              type="radio"
              name="engine"
              value="openAIRealtime"
              aria-describedby={ENGINE_NOTE_IDS.openAIRealtime}
              checked={localSettings.transcriptionEngine === "openAIRealtime"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "openAIRealtime" as TranscriptionEngineType,
                })
              }
            />
            <span>OpenAI Realtime API</span>
            <span id={ENGINE_NOTE_IDS.openAIRealtime} className="settings-note">
              音声をOpenAIへ送信 / API キーが必要
            </span>
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
            aria-label={whisperModelLabel}
            title={whisperModelLabel}
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
          aria-label={microphoneDeviceLabel}
          title={microphoneDeviceLabel}
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
          <div
            className="settings-inline-error"
            role="alert"
            aria-label={`マイクデバイス一覧エラー: ${String(devicesError)}`}
            title={`マイクデバイス一覧エラー: ${String(devicesError)}`}
          >
            <span>マイクデバイス一覧の取得に失敗しました: {String(devicesError)}</span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchDevices()}
              disabled={isFetchingDevices}
              aria-label={retryDevicesLabel}
              title={retryDevicesLabel}
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
          aria-label={languageLabel}
          title={languageLabel}
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
          <div className="settings-output-summary">
            <span
              className="settings-output-mode"
              title={`出力先ディレクトリ: ${outputDirectoryModeLabel}`}
            >
              {outputDirectoryModeLabel}
            </span>
            <span
              className="settings-output-path"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={outputDirectoryLabel}
              title={outputDirectoryLabel}
            >
              {outputDirectoryDisplayText}
            </span>
          </div>
          {defaultOutputDirError && !localSettings.outputDirectory && (
            <div
              className="settings-inline-error"
              role="alert"
              aria-label={`デフォルト出力先ディレクトリエラー: ${String(defaultOutputDirError)}`}
              title={`デフォルト出力先ディレクトリエラー: ${String(defaultOutputDirError)}`}
            >
              <span>
                デフォルト出力先の取得に失敗しました: {String(defaultOutputDirError)}
              </span>
              <button
                type="button"
                className="control-btn control-btn-clear"
                onClick={() => refetchDefaultOutputDir()}
                disabled={isFetchingDefaultOutputDir}
                aria-label={retryDefaultOutputDirLabel}
                title={retryDefaultOutputDirLabel}
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
              aria-label={selectOutputDirectoryLabel}
              title={selectOutputDirectoryLabel}
            >
              {isSelectingOutputDirectory ? "選択中..." : "フォルダ選択"}
            </button>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={handleResetOutputDirectory}
              disabled={isSelectingOutputDirectory || !localSettings.outputDirectory}
              aria-label={resetOutputDirectoryLabel}
              title={resetOutputDirectoryLabel}
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
            aria-label={permissionRetryLabel}
            title={permissionRetryLabel}
          >
            {isCheckingPermissions ? "確認中..." : "再チェック"}
          </button>
          {hasPermissionStatusAttention && (
            <p className="settings-note">
              {permissionStatusNote}
            </p>
          )}
          <p className="settings-note">
            ブラウザ会議URL検知では、macOS が Safari / Chrome / Edge /
            Firefox の自動操作許可を求める場合があります。URL全文は表示・保存せず、会議サービスとホスト名だけを使います。
          </p>
        </div>
      </div>

      {/* 保存ボタン */}
      <div className="settings-actions">
        {hasChanges && (
          <span
            className="settings-unsaved-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={unsavedSettingsLabel}
            title={unsavedSettingsLabel}
          >
            未保存の変更があります
          </span>
        )}
        <button
          type="button"
          className="control-btn control-btn-transcribe settings-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || updateMutation.isPending}
          aria-label={saveSettingsLabel}
          title={saveSettingsLabel}
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
          title={`設定通知: ${toastMessage}`}
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
  const getBadgeLabel = (text: string) => `${label}: ${text}`;
  const renderBadge = (className: string, text: string, isBusy = false) => (
    <span
      className={`settings-permission-badge${className ? ` ${className}` : ""}`}
      role="status"
      aria-busy={isBusy}
      aria-live="polite"
      aria-atomic="true"
      aria-label={getBadgeLabel(text)}
      title={getBadgeLabel(text)}
    >
      {text}
    </span>
  );

  if (isChecking) {
    return renderBadge("", "確認中...", true);
  }
  if (error) {
    return renderBadge("permission-denied", "確認失敗");
  }
  if (!status) {
    return renderBadge("", "確認中...", true);
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

  const saveApiKeyLabel = setMutation.isPending
    ? "OpenAI API キーを保存中"
    : keyInput.trim()
      ? "OpenAI API キーを保存"
      : "OpenAI API キーを入力すると保存できます";
  const clearApiKeyLabel = clearMutation.isPending
    ? "OpenAI API キーを削除中"
    : isFetchingHasKey
      ? "OpenAI API キー状態を確認中"
      : hasKeyError
        ? "OpenAI API キー状態を確認できないため削除できません"
        : hasKey
          ? "OpenAI API キーを削除"
          : "削除できる OpenAI API キーはありません";
  const apiKeyStatusText = isFetchingHasKey
    ? "確認中"
    : hasKeyError
      ? "確認失敗"
      : hasKey === undefined
        ? "確認中"
        : hasKey
          ? "登録済み"
          : "未登録";
  const apiKeyStatusClassName = hasKeyError
    ? "settings-api-key-status settings-api-key-status-error"
    : hasKey
      ? "settings-api-key-status settings-api-key-status-ready"
      : "settings-api-key-status";
  const apiKeyStatusLabel = `OpenAI API キー状態: ${apiKeyStatusText}`;
  const refetchApiKeyStatusLabel = isFetchingHasKey
    ? "OpenAI API キー状態を確認中"
    : "OpenAI API キー状態を再確認";
  const apiKeyInputLabel = hasKey
    ? "OpenAI API キー: 登録済み、再入力で上書き"
    : "OpenAI API キー: 未登録";

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">OpenAI API キー</h3>
      <p id={OPENAI_API_KEY_NOTE_ID} className="settings-note">
        Keychain に安全に保存され、ブラウザ・ログには出力されません。
      </p>
      <div className="settings-api-key">
        {hasKeyError && (
          <div
            className="settings-inline-error"
            role="alert"
            aria-label={`OpenAI API キー状態エラー: ${String(hasKeyError)}`}
            title={`OpenAI API キー状態エラー: ${String(hasKeyError)}`}
          >
            <span>
              API キー状態の確認に失敗しました: {String(hasKeyError)}
            </span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchHasKey()}
              disabled={isFetchingHasKey}
              aria-label={refetchApiKeyStatusLabel}
              title={refetchApiKeyStatusLabel}
            >
              {isFetchingHasKey ? "確認中..." : "再確認"}
            </button>
          </div>
        )}
        <input
          type="password"
          aria-label={apiKeyInputLabel}
          title={apiKeyInputLabel}
          aria-describedby={OPENAI_API_KEY_NOTE_ID}
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
            aria-label={saveApiKeyLabel}
            title={saveApiKeyLabel}
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
            aria-label={clearApiKeyLabel}
            title={clearApiKeyLabel}
          >
            {clearMutation.isPending ? "削除中..." : "削除"}
          </button>
        </div>
        <div
          className={apiKeyStatusClassName}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={apiKeyStatusLabel}
          title={apiKeyStatusLabel}
        >
          状態: {apiKeyStatusText}
        </div>
      </div>
    </div>
  );
}
