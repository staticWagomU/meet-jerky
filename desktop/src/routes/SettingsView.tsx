import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppSettings, AudioDevice, TranscriptionEngineType } from "../types";
import { usePermissions } from "../hooks/usePermissions";
import { toErrorMessage } from "../utils/errorMessage";
import {
  MACOS_ACCESSIBILITY_PRIVACY_URL,
  MACOS_MICROPHONE_PRIVACY_URL,
  MACOS_SCREEN_RECORDING_PRIVACY_URL,
  OPEN_ACCESSIBILITY_PRIVACY_LABEL,
  OPEN_MICROPHONE_PRIVACY_LABEL,
  OPEN_SCREEN_RECORDING_PRIVACY_LABEL,
} from "../utils/macosPrivacySettings";
import {
  buildLiveCaptionStatusFromEngine,
  LIVE_CAPTION_STATUS_EVENT,
  type LiveCaptionStatusPayload,
  writeStoredLiveCaptionStatus,
} from "../utils/liveCaptionStatus";
import {
  OTHER_TRACK_PERMISSION_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";

const WHISPER_MODELS = [
  { value: "tiny", label: "Tiny" },
  { value: "base", label: "Base" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large-v3", label: "Large v3" },
];

const OPENAI_API_KEY_NOTE_ID = "openai-api-key-note";
const ELEVENLABS_API_KEY_NOTE_ID = "elevenlabs-api-key-note";
const EXTERNAL_REALTIME_RISK_NOTE_ID = "external-realtime-risk-note";
const APPLE_SPEECH_LIMIT_NOTE_ID = "apple-speech-limit-note";
const ENGINE_NOTE_IDS = {
  whisper: "transcription-engine-note-whisper",
  appleSpeech: "transcription-engine-note-apple-speech",
  openAIRealtime: "transcription-engine-note-openai-realtime",
  elevenLabsRealtime: "transcription-engine-note-elevenlabs-realtime",
} as const;

const LANGUAGES = [
  { value: "auto", label: "自動検出" },
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

function syncLiveCaptionStatus(status: LiveCaptionStatusPayload): void {
  writeStoredLiveCaptionStatus(status, (e) => {
    console.error("ライブ字幕ステータスの保存に失敗しました:", toErrorMessage(e));
  });
  void emit(LIVE_CAPTION_STATUS_EVENT, status).catch((e) => {
    console.error("ライブ字幕ステータスの同期に失敗しました:", toErrorMessage(e));
  });
}

export function SettingsView() {
  const queryClient = useQueryClient();
  const [localSettings, setLocalSettings] = useState<AppSettings | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [permissionSettingsOpenError, setPermissionSettingsOpenError] =
    useState<string | null>(null);
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
    onSuccess: (_data, savedSettings) => {
      syncLiveCaptionStatus(
        buildLiveCaptionStatusFromEngine(savedSettings.transcriptionEngine),
      );
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      showToast("設定を保存しました");
    },
    onError: (error) => {
      showToast(`設定の保存に失敗しました: ${toErrorMessage(error)}`);
    },
    onSettled: () => {
      isSavingSettingsRef.current = false;
    },
  });

  useEffect(() => {
    if (!settings) {
      return;
    }
    syncLiveCaptionStatus(
      buildLiveCaptionStatusFromEngine(settings.transcriptionEngine),
    );
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

  const clearToast = useCallback(() => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToastMessage(null);
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
      clearToast();
      updateMutation.mutate(localSettings);
    }
  }, [clearToast, localSettings, updateMutation]);

  const handleSelectOutputDirectory = useCallback(async () => {
    if (isSelectingOutputDirectory || isSelectingOutputDirectoryRef.current) {
      return;
    }
    isSelectingOutputDirectoryRef.current = true;
    setIsSelectingOutputDirectory(true);
    clearToast();
    try {
      const selected = await invoke<string | null>("select_output_directory");
      if (selected) {
        setLocalSettings((current) =>
          current ? { ...current, outputDirectory: selected } : current,
        );
      }
    } catch (e) {
      console.error("出力先フォルダの選択に失敗しました:", e);
      showToast(`出力先フォルダの選択に失敗しました: ${toErrorMessage(e)}`);
    } finally {
      isSelectingOutputDirectoryRef.current = false;
      setIsSelectingOutputDirectory(false);
    }
  }, [clearToast, isSelectingOutputDirectory, showToast]);

  const handleResetOutputDirectory = useCallback(() => {
    setLocalSettings((current) =>
      current ? { ...current, outputDirectory: null } : current,
    );
  }, []);

  const handleOpenPermissionSettings = useCallback(
    async (url: string, label: string) => {
      setPermissionSettingsOpenError(null);
      try {
        await openUrl(url);
      } catch (e) {
        const msg = toErrorMessage(e);
        console.error(`${label}を開けませんでした:`, msg);
        setPermissionSettingsOpenError(msg);
      }
    },
    [],
  );

  if (settingsError) {
    const settingsErrorMessage = toErrorMessage(settingsError);
    const reloadSettingsLabel = isFetchingSettings
      ? "アプリ設定を読み込み中"
      : "アプリ設定を再読み込み";
    return (
      <div className="settings-view">
        <p
          className="settings-warning"
          role="alert"
          aria-label={`アプリ設定読み込みエラー: ${settingsErrorMessage}`}
          title={`アプリ設定読み込みエラー: ${settingsErrorMessage}`}
        >
          設定の読み込みに失敗しました: {settingsErrorMessage}
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetchSettings()}
          disabled={isFetchingSettings}
          aria-label={reloadSettingsLabel}
          title={reloadSettingsLabel}
        >
          {isFetchingSettings ? "読み込み中..." : "設定を再読み込み"}
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
    (isFetchingDefaultOutputDir
      ? "取得中..."
      : defaultOutputDirError
        ? "取得できません"
        : "未設定");
  const outputDirectoryLabel = localSettings.outputDirectory
    ? `現在の出力先ディレクトリ: ${localSettings.outputDirectory}`
    : defaultOutputDir
      ? `現在の出力先ディレクトリはデフォルトです: ${defaultOutputDir}`
      : isFetchingDefaultOutputDir
        ? "現在の出力先ディレクトリを取得中です"
      : defaultOutputDirError
        ? "現在の出力先ディレクトリを取得できません"
      : "現在の出力先ディレクトリは未設定です";
  const outputDirectoryModeLabel = localSettings.outputDirectory
    ? "カスタム"
    : isFetchingDefaultOutputDir
      ? "取得中"
    : defaultOutputDirError
      ? "確認できません"
    : "デフォルト";
  const selectOutputDirectoryLabel = isSelectingOutputDirectory
    ? "出力先ディレクトリを選択中"
    : "出力先ディレクトリを選択";
  const resetOutputDirectoryLabel = isSelectingOutputDirectory
    ? "出力先ディレクトリを選択中"
    : localSettings.outputDirectory
      ? "出力先ディレクトリ設定をデフォルトに戻す。既存の履歴ファイルは削除しません"
    : isFetchingDefaultOutputDir
      ? "出力先ディレクトリを取得中"
    : defaultOutputDirError
      ? "出力先ディレクトリを取得できないため戻せません"
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
  const whisperModelLabel = `Whisper モデル: ${whisperModelName}`;
  const microphoneDeviceLabel = localSettings.microphoneDeviceId
    ? `${SELF_TRACK_DEVICE_LABEL}のデバイス: ${selectedMicrophoneDeviceName}`
    : `${SELF_TRACK_DEVICE_LABEL}のデバイス: デフォルト`;
  const retryDevicesLabel = isFetchingDevices
    ? `${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を取得中`
    : `${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を再取得`;
  const languageLabel = `文字起こし言語: ${languageName}`;
  const devicesErrorMessage = devicesError ? toErrorMessage(devicesError) : "";
  const retryDefaultOutputDirLabel = isFetchingDefaultOutputDir
    ? "デフォルト出力先ディレクトリを取得中"
    : "デフォルト出力先ディレクトリを再取得";
  const defaultOutputDirErrorMessage = defaultOutputDirError
    ? toErrorMessage(defaultOutputDirError)
    : "";
  const permissionRetryLabel = isCheckingPermissions
    ? "macOS 権限状態を確認中"
    : "macOS の権限を再チェック";
  const permissionSettingsOpenErrorLabel = permissionSettingsOpenError
    ? `macOS 設定を開けませんでした: ${permissionSettingsOpenError}`
    : null;
  const browserAutomationPermissionLabel =
    "自動操作/アクセシビリティ ブラウザ URL 検知: Safari、Chrome、Edge、Brave、Arc、Firefox の URL 検知時に macOS が確認。録音や音声取得の権限ではありません";
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
    ? "macOS の権限状態を読み取れませんでした。自分トラックの録音・文字起こしや相手側のシステム音声取得・文字起こしができるか分からないため、システム設定のプライバシーとセキュリティでマイクと画面収録を確認してください。"
    : "マイクは自分トラックの録音、画面収録は相手側のシステム音声取得に必要です。未許可または未確認の場合はシステム設定のプライバシーとセキュリティで確認してください。";
  const unsavedSettingsLabel = "未保存の変更があります";
  const saveSettingsLabel = updateMutation.isPending
    ? "設定を保存中"
    : hasChanges
      ? "変更した設定を保存"
      : "保存する設定変更はありません";
  const whisperEngineLabel =
    "文字起こしエンジン: ローカル Whisper、端末内のみ、外部送信なし";
  const appleSpeechEngineLabel =
    "文字起こしエンジン: macOS SpeechAnalyzer、端末内のみ、外部送信なし、現在は片側トラック向け";
  const openAIRealtimeEngineLabel =
    "文字起こしエンジン: OpenAI Realtime API、外部送信あり、送信先 OpenAI、API キーが必要";
  const elevenLabsRealtimeEngineLabel =
    "文字起こしエンジン: ElevenLabs Scribe v2 Realtime、外部送信あり、送信先 ElevenLabs、API キーが必要";
  const selectedExternalRealtimeProvider =
    localSettings.transcriptionEngine === "openAIRealtime"
      ? "OpenAI"
      : localSettings.transcriptionEngine === "elevenLabsRealtime"
        ? "ElevenLabs"
        : null;
  const externalRealtimeRiskLabel = selectedExternalRealtimeProvider
    ? `${selectedExternalRealtimeProvider} Realtime は音声を外部 API へ送信します。プロバイダ側の利用量課金が発生する可能性があります。`
    : null;
  const externalRealtimeRiskAriaLabel = externalRealtimeRiskLabel
    ? `${externalRealtimeRiskLabel} API キーは Keychain に保存され、画面には再表示されません。`
    : null;
  const openAIRealtimeDescribedBy =
    localSettings.transcriptionEngine === "openAIRealtime"
      ? `${ENGINE_NOTE_IDS.openAIRealtime} ${EXTERNAL_REALTIME_RISK_NOTE_ID}`
      : ENGINE_NOTE_IDS.openAIRealtime;
  const elevenLabsRealtimeDescribedBy =
    localSettings.transcriptionEngine === "elevenLabsRealtime"
      ? `${ENGINE_NOTE_IDS.elevenLabsRealtime} ${EXTERNAL_REALTIME_RISK_NOTE_ID}`
      : ENGINE_NOTE_IDS.elevenLabsRealtime;
  const appleSpeechDescribedBy =
    localSettings.transcriptionEngine === "appleSpeech"
      ? `${ENGINE_NOTE_IDS.appleSpeech} ${APPLE_SPEECH_LIMIT_NOTE_ID}`
      : ENGINE_NOTE_IDS.appleSpeech;
  const isSettingsViewBusy =
    updateMutation.isPending ||
    isSelectingOutputDirectory ||
    isFetchingSettings ||
    isFetchingDevices ||
    isFetchingDefaultOutputDir ||
    isCheckingPermissions;
  const settingsViewLabel = [
    "アプリ設定",
    updateMutation.isPending ? "設定を保存中" : null,
    isSelectingOutputDirectory ? "出力先フォルダを選択中" : null,
    isFetchingSettings ? "設定を読み込み中" : null,
    isFetchingDevices ? "マイクデバイス一覧を取得中" : null,
    isFetchingDefaultOutputDir ? "デフォルト出力先を取得中" : null,
    isCheckingPermissions ? "macOS 権限状態を確認中" : null,
    hasPermissionStatusAttention ? "権限確認が必要" : null,
    permissionSettingsOpenErrorLabel,
    hasChanges ? "未保存の変更あり" : null,
  ]
    .filter(Boolean)
    .join("、");

  return (
    <div
      className="settings-view"
      aria-busy={isSettingsViewBusy}
      aria-label={settingsViewLabel}
      title={settingsViewLabel}
    >
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
                setLocalSettings((current) =>
                  current
                    ? {
                        ...current,
                        transcriptionEngine: "whisper" as TranscriptionEngineType,
                      }
                    : current,
                )
              }
            />
            <span>ローカル (Whisper)</span>
            <span id={ENGINE_NOTE_IDS.whisper} className="settings-note">
              端末内のみ、外部送信なし
            </span>
          </label>
          <label className="settings-radio-label" title={appleSpeechEngineLabel}>
            <input
              type="radio"
              name="engine"
              value="appleSpeech"
              aria-describedby={appleSpeechDescribedBy}
              checked={localSettings.transcriptionEngine === "appleSpeech"}
              onChange={() =>
                setLocalSettings((current) =>
                  current
                    ? {
                        ...current,
                        transcriptionEngine:
                          "appleSpeech" as TranscriptionEngineType,
                      }
                    : current,
                )
              }
            />
            <span>macOS SpeechAnalyzer</span>
            <span id={ENGINE_NOTE_IDS.appleSpeech} className="settings-note">
              端末内のみ、macOS 26+ 専用。現在は自分または相手側の片側トラック向け
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
              aria-describedby={openAIRealtimeDescribedBy}
              checked={localSettings.transcriptionEngine === "openAIRealtime"}
              onChange={() =>
                setLocalSettings((current) =>
                  current
                    ? {
                        ...current,
                        transcriptionEngine:
                          "openAIRealtime" as TranscriptionEngineType,
                      }
                    : current,
                )
              }
            />
            <span>OpenAI Realtime API</span>
            <span id={ENGINE_NOTE_IDS.openAIRealtime} className="settings-note">
              外部送信あり、送信先 OpenAI、API キーが必要
            </span>
          </label>
          <label
            className="settings-radio-label"
            title={elevenLabsRealtimeEngineLabel}
          >
            <input
              type="radio"
              name="engine"
              value="elevenLabsRealtime"
              aria-describedby={elevenLabsRealtimeDescribedBy}
              checked={localSettings.transcriptionEngine === "elevenLabsRealtime"}
              onChange={() =>
                setLocalSettings((current) =>
                  current
                    ? {
                        ...current,
                        transcriptionEngine:
                          "elevenLabsRealtime" as TranscriptionEngineType,
                      }
                    : current,
                )
              }
            />
            <span>ElevenLabs Scribe v2 Realtime</span>
            <span
              id={ENGINE_NOTE_IDS.elevenLabsRealtime}
              className="settings-note"
            >
              外部送信あり、送信先 ElevenLabs、API キーが必要
            </span>
          </label>
        </div>
        {externalRealtimeRiskLabel && (
          <p
            id={EXTERNAL_REALTIME_RISK_NOTE_ID}
            className="settings-risk-note"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={externalRealtimeRiskAriaLabel ?? undefined}
            title={externalRealtimeRiskAriaLabel ?? undefined}
          >
            {externalRealtimeRiskLabel}
            API キーは Keychain に保存され、画面には再表示されません。
          </p>
        )}
        {localSettings.transcriptionEngine === "appleSpeech" && (
          <p
            id={APPLE_SPEECH_LIMIT_NOTE_ID}
            className="settings-risk-note"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label="Apple Speech 制約: 現在の記録開始ボタンは自分と相手側の両トラックを同時に開始するため、Apple Speech では安全のため無効化されます。片側トラックだけを手動開始して利用してください。"
            title="Apple Speech 制約: 現在の記録開始ボタンは自分と相手側の両トラックを同時に開始するため、Apple Speech では安全のため無効化されます。片側トラックだけを手動開始して利用してください。"
          >
            記録開始ボタンは両トラックを同時に開始するため、Apple Speech
            では安全のため無効化されます。片側トラックだけを手動開始して利用してください。
          </p>
        )}
      </div>

      {/* 外部 Realtime API キー */}
      {localSettings.transcriptionEngine === "openAIRealtime" && (
        <ExternalApiKeySection
          providerName="OpenAI"
          noteId={OPENAI_API_KEY_NOTE_ID}
          queryKey={["openaiApiKey", "has"]}
          hasCommand="has_openai_api_key"
          setCommand="set_openai_api_key"
          clearCommand="clear_openai_api_key"
          placeholder="sk-..."
          clearToast={clearToast}
          showToast={showToast}
        />
      )}
      {localSettings.transcriptionEngine === "elevenLabsRealtime" && (
        <ExternalApiKeySection
          providerName="ElevenLabs"
          noteId={ELEVENLABS_API_KEY_NOTE_ID}
          queryKey={["elevenlabsApiKey", "has"]}
          hasCommand="has_elevenlabs_api_key"
          setCommand="set_elevenlabs_api_key"
          clearCommand="clear_elevenlabs_api_key"
          placeholder="xi-..."
          clearToast={clearToast}
          showToast={showToast}
        />
      )}

      {/* Whisper モデル */}
      {localSettings.transcriptionEngine === "whisper" && (
        <div className="settings-section">
          <h3 className="settings-section-title">Whisper モデル</h3>
          <select
            aria-label={whisperModelLabel}
            title={whisperModelLabel}
            value={localSettings.whisperModel}
            onChange={(e) =>
              setLocalSettings((current) =>
                current ? { ...current, whisperModel: e.target.value } : current,
              )
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
        <h3 className="settings-section-title">自分トラックのマイク</h3>
        <select
          aria-label={microphoneDeviceLabel}
          title={microphoneDeviceLabel}
          value={localSettings.microphoneDeviceId ?? ""}
          onChange={(e) =>
            setLocalSettings((current) =>
              current
                ? { ...current, microphoneDeviceId: e.target.value || null }
                : current,
            )
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
            aria-label={`${SELF_TRACK_DEVICE_LABEL}のデバイス一覧エラー: ${devicesErrorMessage}`}
            title={`${SELF_TRACK_DEVICE_LABEL}のデバイス一覧エラー: ${devicesErrorMessage}`}
          >
            <span>
              自分トラックのマイクデバイス一覧の取得に失敗しました:{" "}
              {devicesErrorMessage}
            </span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchDevices()}
              disabled={isFetchingDevices}
              aria-label={retryDevicesLabel}
              title={retryDevicesLabel}
            >
              {isFetchingDevices ? "取得中..." : "デバイスを再取得"}
            </button>
          </div>
        )}
      </div>

      {/* 言語 */}
      <div className="settings-section">
        <h3 className="settings-section-title">文字起こし言語</h3>
        <select
          aria-label={languageLabel}
          title={languageLabel}
          value={localSettings.language}
          onChange={(e) =>
            setLocalSettings((current) =>
              current ? { ...current, language: e.target.value } : current,
            )
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
              aria-label={`出力先ディレクトリ: ${outputDirectoryModeLabel}`}
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
              aria-label={`デフォルト出力先ディレクトリエラー: ${defaultOutputDirErrorMessage}`}
              title={`デフォルト出力先ディレクトリエラー: ${defaultOutputDirErrorMessage}`}
            >
              <span>
                デフォルト出力先の取得に失敗しました:{" "}
                {defaultOutputDirErrorMessage}
              </span>
              <button
                type="button"
                className="control-btn control-btn-clear"
                onClick={() => refetchDefaultOutputDir()}
                disabled={isFetchingDefaultOutputDir}
                aria-label={retryDefaultOutputDirLabel}
                title={retryDefaultOutputDirLabel}
              >
                {isFetchingDefaultOutputDir ? "取得中..." : "出力先を再取得"}
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
              {isSelectingOutputDirectory ? "選択中..." : "出力先を選択"}
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
              <span className="settings-permission-track">自分</span> マイク
            </span>
            <PermissionBadge
              label={`${SELF_TRACK_DEVICE_LABEL} macOS マイク権限`}
              status={micPermission}
              error={micPermissionError}
              isChecking={isFetchingMicPermission}
            />
          </div>
          <div className="settings-permission-row">
            <span className="settings-permission-label">
              <span className="settings-permission-track">相手側</span>{" "}
              画面収録/システム音声
            </span>
            <PermissionBadge
              label={`${OTHER_TRACK_PERMISSION_LABEL} macOS 画面収録権限`}
              status={screenPermission}
              error={screenPermissionError}
              isChecking={isFetchingScreenPermission}
            />
          </div>
          <div className="settings-permission-row">
            <span className="settings-permission-label">
              自動操作/アクセシビリティ{" "}
              <span className="settings-permission-track">ブラウザ URL</span>
            </span>
            <span
              className="settings-permission-badge permission-undetermined"
              role="status"
              aria-label={browserAutomationPermissionLabel}
              title={browserAutomationPermissionLabel}
            >
              URL 検知時に確認
            </span>
          </div>
          <div className="settings-permission-actions">
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => {
                setPermissionSettingsOpenError(null);
                refetchPermissions();
              }}
              disabled={isCheckingPermissions}
              aria-label={permissionRetryLabel}
              title={permissionRetryLabel}
            >
              {isCheckingPermissions ? "確認中..." : "権限を再チェック"}
            </button>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() =>
                void handleOpenPermissionSettings(
                  MACOS_MICROPHONE_PRIVACY_URL,
                  "マイク権限設定",
                )
              }
              aria-label={OPEN_MICROPHONE_PRIVACY_LABEL}
              title={OPEN_MICROPHONE_PRIVACY_LABEL}
            >
              マイク設定を開く
            </button>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() =>
                void handleOpenPermissionSettings(
                  MACOS_SCREEN_RECORDING_PRIVACY_URL,
                  "画面収録設定",
                )
              }
              aria-label={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
              title={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
            >
              画面収録設定を開く
            </button>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() =>
                void handleOpenPermissionSettings(
                  MACOS_ACCESSIBILITY_PRIVACY_URL,
                  "アクセシビリティ権限設定",
                )
              }
              aria-label={OPEN_ACCESSIBILITY_PRIVACY_LABEL}
              title={OPEN_ACCESSIBILITY_PRIVACY_LABEL}
            >
              アクセシビリティ設定を開く
            </button>
          </div>
          {permissionSettingsOpenErrorLabel && (
            <p
              className="settings-inline-error"
              role="alert"
              aria-label={permissionSettingsOpenErrorLabel}
              title={permissionSettingsOpenErrorLabel}
            >
              <span>{permissionSettingsOpenErrorLabel}</span>
            </p>
          )}
          {hasPermissionStatusAttention && (
            <p className="settings-note">
              {permissionStatusNote}
            </p>
          )}
          <p className="settings-note">
            ブラウザ会議 URL 検知では、macOS が Safari、Chrome、Edge、Brave、Arc、Firefox
            の自動操作またはアクセシビリティ許可を求める場合があります。URL 全体は表示・保存せず、会議サービスとホスト名だけを使います。
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
          {updateMutation.isPending
            ? "保存中..."
            : hasChanges
              ? "設定を保存"
              : "保存済み"}
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
  const renderBadge = (
    className: string,
    text: string,
    isBusy = false,
    description = text,
  ) => {
    const badgeLabel = getBadgeLabel(description);
    return (
      <span
        className={`settings-permission-badge${className ? ` ${className}` : ""}`}
        role="status"
        aria-busy={isBusy}
        aria-live="polite"
        aria-atomic="true"
        aria-label={badgeLabel}
        title={badgeLabel}
      >
        {text}
      </span>
    );
  };

  if (isChecking) {
    return renderBadge("", "確認中...", true);
  }
  if (error) {
    return renderBadge(
      "permission-denied",
      "確認できません",
      false,
      `確認できません: ${toErrorMessage(error)}`,
    );
  }
  if (!status) {
    return renderBadge("", "確認中...", true);
  }
  if (status === "granted") {
    return renderBadge("permission-granted", "許可済み");
  }
  if (status === "denied") {
    return renderBadge("permission-denied", "未許可");
  }
  return renderBadge("permission-undetermined", "未確認");
}

function ExternalApiKeySection({
  providerName,
  noteId,
  queryKey,
  hasCommand,
  setCommand,
  clearCommand,
  placeholder,
  clearToast,
  showToast,
}: {
  providerName: string;
  noteId: string;
  queryKey: readonly string[];
  hasCommand: string;
  setCommand: string;
  clearCommand: string;
  placeholder: string;
  clearToast: () => void;
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
    queryKey,
    queryFn: () => invoke<boolean>(hasCommand),
  });

  const setMutation = useMutation({
    mutationFn: (apiKey: string) => invoke(setCommand, { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setKeyInput("");
      showToast(`${providerName} API キーを保存しました`);
    },
    onError: (e) =>
      showToast(`${providerName} API キーの保存に失敗しました: ${toErrorMessage(e)}`),
    onSettled: () => {
      isSettingApiKeyRef.current = false;
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => invoke(clearCommand),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setKeyInput("");
      showToast(`${providerName} API キーを削除しました`);
    },
    onError: (e) =>
      showToast(`${providerName} API キーの削除に失敗しました: ${toErrorMessage(e)}`),
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
    clearToast();
    setMutation.mutate(apiKey);
  }, [clearToast, keyInput, setMutation]);

  const handleClearApiKey = useCallback(() => {
    if (
      setMutation.isPending ||
      clearMutation.isPending ||
      isClearingApiKeyRef.current ||
      isFetchingHasKey ||
      !hasKey ||
      Boolean(hasKeyError)
    ) {
      return;
    }
    isClearingApiKeyRef.current = true;
    clearToast();
    clearMutation.mutate();
  }, [
    clearToast,
    clearMutation,
    hasKey,
    hasKeyError,
    isFetchingHasKey,
    setMutation.isPending,
  ]);

  const isApiKeyOperationPending =
    setMutation.isPending || clearMutation.isPending;

  const saveApiKeyLabel = setMutation.isPending
    ? `${providerName} API キーを保存中`
    : keyInput.trim()
      ? `${providerName} API キーを保存`
      : `${providerName} API キーを入力すると保存できます`;
  const clearApiKeyLabel = clearMutation.isPending
    ? `${providerName} API キーを削除中`
    : setMutation.isPending
      ? `${providerName} API キーを保存中のため削除できません`
    : isFetchingHasKey
      ? `${providerName} API キーの状態を確認中`
      : hasKeyError
        ? `${providerName} API キーの状態を確認できないため削除できません`
        : hasKey
          ? `${providerName} API キーを削除`
          : `削除できる ${providerName} API キーはありません`;
  const apiKeyStatusText = isFetchingHasKey
    ? "確認中"
    : hasKeyError
      ? "確認できません"
      : hasKey === undefined
        ? "確認中"
        : hasKey
          ? "登録済み"
          : "未登録";
  const apiKeyStatusClassName = hasKeyError
    ? "settings-api-key-status settings-api-key-status-error"
    : isFetchingHasKey || hasKey === undefined
      ? "settings-api-key-status"
      : hasKey
      ? "settings-api-key-status settings-api-key-status-ready"
      : "settings-api-key-status";
  const apiKeyStatusLabel = hasKey
    ? `${providerName} API キーの状態: 登録済み。キー値は画面に再表示されません`
    : `${providerName} API キーの状態: ${apiKeyStatusText}`;
  const refetchApiKeyStatusLabel = isFetchingHasKey
    ? `${providerName} API キーの状態を確認中`
    : `${providerName} API キーの状態を再確認`;
  const apiKeyErrorMessage = hasKeyError ? toErrorMessage(hasKeyError) : "";
  const apiKeyInputLabel = hasKeyError
    ? `${providerName} API キー: 状態を確認できません。入力すると保存できます`
    : isFetchingHasKey || hasKey === undefined
      ? `${providerName} API キー: 状態を確認中。入力すると保存できます`
      : hasKey
        ? `${providerName} API キー: 登録済み、再入力で上書き`
        : `${providerName} API キー: 未登録`;

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{providerName} API キー</h3>
      <p id={noteId} className="settings-note">
        Keychain に保存され、キー値はアプリ画面へ再表示されません。ブラウザ・ログにも出力されません。
      </p>
      <div className="settings-api-key">
        {hasKeyError && (
          <div
            className="settings-inline-error"
            role="alert"
            aria-label={`${providerName} API キーの状態確認エラー: ${apiKeyErrorMessage}`}
            title={`${providerName} API キーの状態確認エラー: ${apiKeyErrorMessage}`}
          >
            <span>
              {providerName} API キーの状態確認に失敗しました:{" "}
              {apiKeyErrorMessage}
            </span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchHasKey()}
              disabled={isFetchingHasKey}
              aria-label={refetchApiKeyStatusLabel}
              title={refetchApiKeyStatusLabel}
            >
              {isFetchingHasKey ? "確認中..." : "状態を再確認"}
            </button>
          </div>
        )}
        <input
          type="password"
          aria-label={apiKeyInputLabel}
          title={apiKeyInputLabel}
          aria-describedby={noteId}
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? "登録済み (再入力で上書き)" : placeholder}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          disabled={isApiKeyOperationPending}
          className="settings-input"
        />
        <div className="settings-api-key-actions">
          <button
            type="button"
            className="control-btn control-btn-transcribe"
            disabled={!keyInput.trim() || isApiKeyOperationPending}
            onClick={handleSetApiKey}
            aria-label={saveApiKeyLabel}
            title={saveApiKeyLabel}
          >
            {setMutation.isPending ? "保存中..." : "キーを保存"}
          </button>
          <button
            type="button"
            className="control-btn control-btn-clear"
            disabled={
              !hasKey ||
              Boolean(hasKeyError) ||
              isFetchingHasKey ||
              setMutation.isPending ||
              clearMutation.isPending
            }
            onClick={handleClearApiKey}
            aria-label={clearApiKeyLabel}
            title={clearApiKeyLabel}
          >
            {clearMutation.isPending ? "削除中..." : "キーを削除"}
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
