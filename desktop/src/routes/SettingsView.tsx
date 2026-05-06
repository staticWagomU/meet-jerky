import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Flag,
  History,
  LayoutTemplate,
  ListChecks,
  Mic,
  Search,
  Settings,
  Shield,
  Sparkles,
  Type,
  type LucideIcon,
} from "lucide-react";
import { AudioLevelMeter } from "../components/AudioLevelMeter";
import type { AppSettings, AudioDevice, TranscriptionEngineType } from "../types";
import { usePermissions } from "../hooks/usePermissions";
import { toErrorMessage } from "../utils/errorMessage";
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
import { STATUS_CHECKING_LABEL, STATUS_UNCHECKABLE_LABEL, STATUS_UNDETERMINED_LABEL } from "../utils/statusLabels";

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

const SETTINGS_CATEGORIES = [
  {
    key: "general",
    label: "一般",
    icon: Settings,
    kicker: "基本設定",
    title: "一般",
    subtitle: "自動キャプチャを安定させつつ、録音とAI処理を可視化します。",
  },
  {
    key: "detection",
    label: "検出",
    icon: Search,
    kicker: "会議検出",
    title: "会議の検出",
    subtitle:
      "キャプチャ前にURL・アプリ名・アクティブウィンドウ・音声状態を確認します。",
  },
  {
    key: "audio",
    label: "音声",
    icon: Mic,
    kicker: "音声取得",
    title: "音声トラックを分離",
    subtitle:
      "自分の声と会議音声を別々に録音し、文字起こしを明瞭にします。",
  },
  {
    key: "transcription",
    label: "文字起こし",
    icon: Type,
    kicker: "リアルタイム文字起こし",
    title: "文字起こし",
    subtitle:
      "録音音声を検索可能なテキストに変換する方法を選びます。ローカル優先、必要に応じて外部サービスも使えます。",
  },
  {
    key: "aiMinutes",
    label: "AI議事録",
    icon: Sparkles,
    kicker: "AI議事録",
    title: "AI議事録",
    subtitle:
      "文字起こしをAIプロバイダーに送り、構造化された議事録を生成します。明示的な許可があるときだけ送信されます。",
  },
  {
    key: "privacy",
    label: "プライバシー",
    icon: Shield,
    kicker: "透明性",
    title: "プライバシー",
    subtitle: "この Mac に残すもの・外に出すもの・保持期間を決めます。",
  },
] satisfies ReadonlyArray<{
  key: string;
  label: string;
  icon: LucideIcon;
  kicker: string;
  title: string;
  subtitle: string;
}>;

type SettingsCategoryKey = (typeof SETTINGS_CATEGORIES)[number]["key"];

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
  const [permissionSettingsOpenError] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const lastSyncedSettingsRef = useRef<AppSettings | null>(null);
  const isSavingSettingsRef = useRef(false);
  const [activeCategory, setActiveCategory] =
    useState<SettingsCategoryKey>("general");

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
    micPermission,
    micPermissionError,
    isFetchingMicPermission,
    screenPermission,
    screenPermissionError,
    isFetchingScreenPermission,
    isCheckingPermissions,
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
  const permissionSettingsOpenErrorLabel = permissionSettingsOpenError
    ? `macOS 設定を開けませんでした: ${permissionSettingsOpenError}`
    : null;
  const accessibilityPermissionLabel = "アクセシビリティ権限は任意です";
  const hasPermissionCheckError =
    Boolean(micPermissionError) || Boolean(screenPermissionError);
  const hasPermissionStatusAttention =
    !isCheckingPermissions &&
    (hasPermissionCheckError ||
      micPermission === "denied" ||
      micPermission === "undetermined" ||
      screenPermission === "denied" ||
      screenPermission === "undetermined");
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
    isFetchingSettings ||
    isFetchingDevices ||
    isCheckingPermissions;
  const settingsViewLabel = [
    "アプリ設定",
    updateMutation.isPending ? "設定を保存中" : null,
    isFetchingSettings ? "設定を読み込み中" : null,
    isFetchingDevices ? "マイクデバイス一覧を取得中" : null,
    isCheckingPermissions ? "macOS 権限状態を確認中" : null,
    hasPermissionStatusAttention ? "権限確認が必要" : null,
    permissionSettingsOpenErrorLabel,
    hasChanges ? "未保存の変更あり" : null,
  ]
    .filter(Boolean)
    .join("、");
  const activeCategoryMeta =
    SETTINGS_CATEGORIES.find((category) => category.key === activeCategory) ??
    SETTINGS_CATEGORIES[0];
  const activeCategoryTitleId = `settings-${activeCategoryMeta.key}-title`;
  const isEditableCategory =
    activeCategory === "transcription" ||
    activeCategory === "audio" ||
    activeCategory === "general" ||
    activeCategory === "privacy";
  const shouldShowSettingsActions = isEditableCategory || hasChanges;

  return (
    <div
      className="settings-view"
      aria-busy={isSettingsViewBusy}
      aria-label={settingsViewLabel}
      title={settingsViewLabel}
    >
      <div className="settings-window" role="group" aria-label="設定ウィンドウ">
        <div className="settings-titlebar">
          <div className="settings-window-controls" aria-hidden="true">
            <span className="settings-window-control settings-window-control-close" />
            <span className="settings-window-control settings-window-control-minimize" />
            <span className="settings-window-control settings-window-control-zoom" />
          </div>
          <div className="settings-titlebar-copy">
            <h2>設定</h2>
            <p className="settings-titlebar-subtitle">
              録音・検出・AI処理の透明性を管理します。
            </p>
          </div>
          <span
            className="settings-recording-visibility-pill"
            aria-label="録音中に表示されます"
            title="録音中に表示されます"
          >
            <span
              className="settings-recording-visibility-dot"
              aria-hidden="true"
            />
            録音中に表示されます
          </span>
        </div>

        <div className="settings-window-body">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-brand" aria-label="meet-jerky">
              <span className="settings-sidebar-brand-icon" aria-hidden="true">
                <Mic size={16} strokeWidth={2.2} />
              </span>
              <span className="settings-sidebar-brand-name">meet-jerky</span>
            </div>
            <nav
              className="settings-sidebar-nav"
              aria-label={`設定カテゴリ。現在は ${activeCategoryMeta.label} の設定見出しを表示しています`}
            >
              {SETTINGS_CATEGORIES.map((item) => {
                const isActive = item.key === activeCategory;
                const ItemIcon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={
                      isActive
                        ? "settings-sidebar-item settings-sidebar-item-active"
                        : "settings-sidebar-item"
                    }
                    aria-pressed={isActive}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => setActiveCategory(item.key)}
                  >
                    <span className="settings-sidebar-item-icon" aria-hidden="true">
                      <ItemIcon size={16} strokeWidth={2} />
                    </span>
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="settings-sidebar-note">
              <span className="settings-sidebar-note-title">
                ローカル優先で記録
              </span>
              <span>議事録生成を有効にするまでAI送信はオフです。</span>
            </div>
          </aside>

          <main className="settings-main-pane" aria-labelledby={activeCategoryTitleId}>
            <div className="settings-main-heading">
              <div>
                <p className="settings-titlebar-kicker">
                  {activeCategoryMeta.kicker}
                </p>
                <h2 id={activeCategoryTitleId}>{activeCategoryMeta.title}</h2>
                <p className="settings-main-subtitle">
                  {activeCategoryMeta.subtitle}
                </p>
              </div>
              {hasChanges && (
                <span
                  className="settings-unsaved-status settings-unsaved-status-compact"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-label={unsavedSettingsLabel}
                  title={unsavedSettingsLabel}
                >
                  未保存
                </span>
              )}
            </div>

            {activeCategory === "transcription" && (
              <div className="settings-readonly-grid settings-readonly-grid-transcription">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-transcription-engine-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Type size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          文字起こしエンジン
                        </h3>
                        <p className="settings-detection-subtitle">
                          メインエンジンを選択。クラウドエンジンはオプトイン時のみ使用します。
                        </p>
                      </div>
                    </div>
                    <div
                      className="settings-transcription-engine-list"
                      role="radiogroup"
                      aria-labelledby="transcription-engine-title"
                    >
                      <h4 id="transcription-engine-title" className="sr-only">
                        文字起こしエンジン
                      </h4>
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
                      <label
                        className="settings-radio-label"
                        title={appleSpeechEngineLabel}
                      >
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

                  <div className="settings-readonly-card settings-transcription-language-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Type size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">言語と単語登録</h3>
                        <p className="settings-detection-subtitle">
                          メイン言語を選び、よく出る単語を補正します。
                        </p>
                      </div>
                    </div>
                    <div className="settings-transcription-language-row">
                      <span className="settings-transcription-language-label">
                        メイン言語
                      </span>
                      <select
                        aria-label={languageLabel}
                        title={languageLabel}
                        value={localSettings.language}
                        onChange={(e) =>
                          setLocalSettings((current) =>
                            current ? { ...current, language: e.target.value } : current,
                          )
                        }
                        className="settings-select settings-transcription-language-select"
                      >
                        {LANGUAGES.map((lang) => (
                          <option key={lang.value} value={lang.value}>
                            {lang.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-transcription-glossary-label">単語登録（4件）</div>
                    <div className="settings-privacy-option-group">
                      <span className="settings-privacy-option settings-privacy-option-active">
                        FY26 OKR
                      </span>
                      <span className="settings-privacy-option">roadmap</span>
                      <span className="settings-privacy-option">QBR</span>
                      <span className="settings-privacy-option">add</span>
                    </div>
                  </div>
                </div>

                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-transcription-output-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Type size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">出力とタイミング</h3>
                        <p className="settings-detection-subtitle">
                          通話中と通話後に文字起こしをどう扱うか
                        </p>
                      </div>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        録音中はライブ字幕を表示
                      </span>
                      <span className="settings-permission-badge permission-manual">
                        <span
                          className="settings-permission-manual-dot"
                          aria-hidden="true"
                        />
                        ON
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        話者を分離（自分／相手）
                      </span>
                      <span className="settings-permission-badge permission-manual">
                        <span
                          className="settings-permission-manual-dot"
                          aria-hidden="true"
                        />
                        ON
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        停止時に文字起こしを自動保存
                      </span>
                      <span className="settings-permission-badge">
                        OFF
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">書き出し形式</span>
                      <div className="settings-privacy-option-group">
                        <span className="settings-privacy-option settings-privacy-option-active">
                          Markdown
                        </span>
                        <span className="settings-privacy-option">VTT</span>
                        <span className="settings-privacy-option">SRT</span>
                        <span className="settings-privacy-option">JSON</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-readonly-card settings-transcription-preview-card">
                    <div className="settings-transcription-preview-head">
                      <h3 className="settings-readonly-card-title">ライブプレビュー</h3>
                      <span className="settings-detection-live-badge">
                        <span className="settings-detection-live-dot" aria-hidden="true" />
                        サンプル
                      </span>
                    </div>
                    <div className="settings-transcription-preview-list">
                      <div className="settings-transcription-preview-line">
                        <span className="settings-transcription-preview-time">00:12</span>
                        <span className="settings-transcription-preview-speaker settings-transcription-preview-speaker-self">
                          自分
                        </span>
                        <span className="settings-transcription-preview-body">
                          FY26 OKRのドラフトを擦り合わせよう。
                        </span>
                      </div>
                      <div className="settings-transcription-preview-line">
                        <span className="settings-transcription-preview-time">00:18</span>
                        <span className="settings-transcription-preview-speaker">
                          相手
                        </span>
                        <span className="settings-transcription-preview-body">
                          了解です。meet-jerkyの文字起こしで正確に記録されます。
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "audio" && (
              <div className="settings-readonly-grid settings-readonly-grid-audio">
                <div className="settings-readonly-column">
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

                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">
                      相手側システム音声
                    </h3>
                    <p>
                      相手側トラックはデスクトップ/アプリ音声として扱います。macOS
                      ではシステム音声取得が画面収録権限に依存するため、画面収録が未許可の場合は相手側音声を取得できません。
                    </p>
                    <p>
                      今後のシステム音声ルーティング設定では、ループバック:
                      会議アプリとして Zoom・Meet・Teams・Webex
                      の音声取得を分かりやすく扱う想定です。
                    </p>
                  </div>

                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">音声品質</h3>
                    <p>
                      ループバック、2秒のテスト音による取得信号プレビュー、音声品質の調整は今後の設定項目です。現時点ではこの画面から操作できません。
                    </p>
                  </div>
                </div>

                <div className="settings-readonly-column">
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">録音トラック</h3>
                    <p>
                      会議中は自分トラックと相手側トラックを別々に扱います。
                    </p>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">自分</span>
                        <span className="settings-permission-badge permission-granted">
                          マイク
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">相手側</span>
                        <span className="settings-permission-badge permission-granted">
                          システム音声
                        </span>
                      </div>
                    </div>
                    <p>
                      取得した音声はタイムスタンプで統合し、履歴や議事録に回します。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "general" && (
              <div className="settings-readonly-grid settings-readonly-grid-detection">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Search size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">会議の検出</h3>
                        <p className="settings-detection-subtitle">
                          キャプチャ前にURL・アプリ名・アクティブウィンドウ・音声状態を確認します。
                        </p>
                      </div>
                      <span className="settings-detection-status">
                        <span className="settings-detection-status-dot" aria-hidden="true" />
                        動作中
                      </span>
                    </div>
                    <div
                      className="settings-detection-service-chips"
                      aria-label="検出対象"
                    >
                      <span className="settings-detection-chip settings-detection-chip-active">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        Meet
                      </span>
                      <span className="settings-detection-chip settings-detection-chip-active">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        Zoom
                      </span>
                      <span className="settings-detection-chip settings-detection-chip-muted">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        Teams
                      </span>
                      <span className="settings-detection-chip settings-detection-chip-muted">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        URL
                      </span>
                    </div>
                    <div className="settings-detection-auto-row">
                      <span className="settings-detection-auto-label">
                        会議音声を検出したら自動開始
                      </span>
                      <span className="settings-detection-auto-switch" aria-hidden="true">
                        <span className="settings-detection-auto-knob" />
                      </span>
                    </div>
                  </div>

                  <div className="settings-readonly-card settings-detection-card settings-general-audio-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Mic size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title settings-general-audio-title">
                          音声トラックを分離
                        </h3>
                        <p className="settings-detection-subtitle">
                          自分の声と会議音声を別々に録音し、文字起こしを明瞭にします。
                        </p>
                      </div>
                    </div>
                    <div className="settings-general-audio-grid">
                      <div className="settings-general-audio-mini">
                        <div className="settings-general-audio-mini-head">
                          <div
                            className="settings-detection-icon-box settings-detection-icon-box-small"
                            aria-hidden="true"
                          >
                            <Mic size={14} strokeWidth={2} />
                          </div>
                          <div className="settings-general-audio-mini-title-wrap">
                            <h4 className="settings-general-audio-mini-title">
                              マイク入力
                            </h4>
                            <p className="settings-general-audio-mini-subtitle">
                              自分の声を録音
                            </p>
                          </div>
                        </div>
                        <select
                          aria-label="自分の声の入力デバイス"
                          title="自分の声の入力デバイス"
                          value={localSettings.microphoneDeviceId ?? ""}
                          onChange={(e) =>
                            setLocalSettings((current) =>
                              current
                                ? {
                                    ...current,
                                    microphoneDeviceId: e.target.value || null,
                                  }
                                : current,
                            )
                          }
                          className="settings-select"
                        >
                          <option value="">MacBook Pro Microphone</option>
                          {devices?.map((device) => (
                            <option key={device.id} value={device.id}>
                              {device.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="settings-general-audio-mini">
                        <div className="settings-general-audio-mini-head">
                          <div
                            className="settings-detection-icon-box settings-detection-icon-box-small"
                            aria-hidden="true"
                          >
                            <Type size={14} strokeWidth={2} />
                          </div>
                          <div className="settings-general-audio-mini-title-wrap">
                            <h4 className="settings-general-audio-mini-title">
                              システム音声
                            </h4>
                            <p className="settings-general-audio-mini-subtitle">
                              ループバック: 会議アプリ
                            </p>
                          </div>
                        </div>
                        <select
                          aria-label="会議音声のループバック設定"
                          title="会議音声のループバック設定"
                          defaultValue="meeting-apps"
                          disabled
                          className="settings-select"
                        >
                          <option value="meeting-apps">ループバック: 会議アプリ</option>
                        </select>
                      </div>
                    </div>
                    <div className="settings-general-meter-row">
                      <span className="settings-general-meter-label">自分</span>
                      <div className="settings-general-meter-bar">
                        <AudioLevelMeter level={0.74} label="自分トラックの音量" />
                      </div>
                    </div>
                    <div className="settings-general-meter-row">
                      <span className="settings-general-meter-label">相手</span>
                      <div className="settings-general-meter-bar">
                        <AudioLevelMeter level={0.58} label="相手側トラックの音量" />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-log-card settings-general-transparency-card">
                    <div className="settings-detection-log-head">
                      <div className="settings-detection-icon-box settings-detection-icon-box-small" aria-hidden="true">
                        <Shield size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">録音の透明性</h3>
                        <p className="settings-detection-subtitle">
                          メニューバー・字幕ウィンドウ・履歴で録音状態を確認できます。
                        </p>
                      </div>
                    </div>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">マイク</span>
                        <span
                          className={`settings-permission-badge ${
                            micPermission === "granted"
                              ? "permission-granted"
                              : micPermission === "denied"
                                ? "permission-denied"
                                : "permission-undetermined"
                          }`}
                        >
                          <span
                            className={
                              micPermission === "granted"
                                ? "settings-detection-status-dot"
                                : "settings-permission-manual-dot"
                            }
                            aria-hidden="true"
                          />
                          {isCheckingPermissions
                            ? STATUS_CHECKING_LABEL
                            : micPermission === "granted"
                              ? "許可済み"
                              : micPermission === "denied"
                                ? "未許可"
                                : STATUS_UNDETERMINED_LABEL}
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">システム音声</span>
                        <span
                          className={`settings-permission-badge ${
                            screenPermission === "granted"
                              ? "permission-granted"
                              : screenPermission === "denied"
                                ? "permission-denied"
                                : "permission-undetermined"
                          }`}
                        >
                          <span
                            className={
                              screenPermission === "granted"
                                ? "settings-detection-status-dot"
                                : "settings-permission-manual-dot"
                            }
                            aria-hidden="true"
                          />
                          {isCheckingPermissions
                            ? STATUS_CHECKING_LABEL
                            : screenPermission === "granted"
                              ? "許可済み"
                              : screenPermission === "denied"
                                ? "未許可"
                                : STATUS_UNDETERMINED_LABEL}
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">AI議事録</span>
                        <span className="settings-permission-badge permission-manual">
                          <span
                            className="settings-permission-manual-dot"
                            aria-hidden="true"
                          />
                          手動
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "privacy" && (
              <div className="settings-readonly-grid settings-readonly-grid-privacy">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">データ保持期間</h3>
                    <p>
                      録音・文字起こし・議事録を指定日数後に自動削除します。
                    </p>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">保持期間</span>
                      <div className="settings-privacy-option-group">
                        <span className="settings-privacy-option settings-privacy-option-active">
                          7日
                        </span>
                        <span className="settings-privacy-option">30日</span>
                        <span className="settings-privacy-option">90日</span>
                        <span className="settings-privacy-option">削除しない</span>
                      </div>
                    </div>
                  </div>
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">ローカルデータ</h3>
                    <p>
                      録音は削除するまでホームフォルダに保存されます。
                    </p>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          ローカル限定モード
                        </span>
                        <span
                          className="settings-privacy-switch settings-privacy-switch-off"
                          role="status"
                          aria-label="ローカル限定モード: オフ"
                          title="ローカル限定モード: オフ"
                        >
                          <span
                            className="settings-privacy-switch-knob"
                            aria-hidden="true"
                          />
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">ディスク使用量</span>
                        <span
                          className="settings-privacy-storage-badge"
                          role="status"
                          aria-label="ディスク使用量: 3.4 GB・47セッション"
                          title="ディスク使用量: 3.4 GB・47セッション"
                        >
                          3.4 GB・47セッション
                        </span>
                      </div>
                    </div>
                    <div className="settings-permission-actions">
                      <button
                        type="button"
                        className="control-btn control-btn-clear"
                        aria-label="Finder で表示"
                        title="Finder で表示"
                      >
                        Finderで表示
                      </button>
                      <button
                        type="button"
                        className="control-btn control-btn-clear"
                        aria-label="すべて削除"
                        title="すべて削除"
                      >
                        すべて削除
                      </button>
                    </div>
                  </div>
                </div>
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">システム権限</h3>
                    <p>macOS のシステム設定で付与済み。</p>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">マイク</span>
                        <PermissionBadge
                          label={`${SELF_TRACK_DEVICE_LABEL} macOS マイク権限`}
                          status={micPermission}
                          error={micPermissionError}
                          isChecking={isFetchingMicPermission}
                        />
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          画面と音声収録
                        </span>
                        <PermissionBadge
                          label={`${OTHER_TRACK_PERMISSION_LABEL} macOS 画面収録権限`}
                          status={screenPermission}
                          error={screenPermissionError}
                          isChecking={isFetchingScreenPermission}
                        />
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">アクセシビリティ</span>
                        <span
                          className="settings-permission-badge permission-manual"
                          role="status"
                          aria-label={accessibilityPermissionLabel}
                          title={accessibilityPermissionLabel}
                        >
                          <span
                            className="settings-permission-manual-dot"
                            aria-hidden="true"
                          />
                          任意
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">テレメトリー</h3>
                    <p>
                      テレメトリーはすべてオプトイン。文字起こしは送信されません。
                    </p>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">匿名利用統計</span>
                        <span
                          className="settings-privacy-switch settings-privacy-switch-off"
                          role="status"
                          aria-label="匿名利用統計: オフ"
                          title="匿名利用統計: オフ"
                        >
                          <span
                            className="settings-privacy-switch-knob"
                            aria-hidden="true"
                          />
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">クラッシュレポート</span>
                        <span
                          className="settings-privacy-switch settings-privacy-switch-on"
                          role="status"
                          aria-label="クラッシュレポート: オン"
                          title="クラッシュレポート: オン"
                        >
                          <span
                            className="settings-privacy-switch-knob"
                            aria-hidden="true"
                          />
                        </span>
                      </div>
                    </div>
                    <p>
                      クラッシュレポートには macOS のバージョンとビルド情報だけが含まれます。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "detection" && (
              <div className="settings-readonly-grid settings-readonly-grid-detection">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Search size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">会議の検出</h3>
                        <p className="settings-detection-subtitle">
                          キャプチャ前にURL・アプリ名・アクティブウィンドウ・音声状態を確認します。
                        </p>
                      </div>
                      <span className="settings-detection-status">
                        <span className="settings-detection-status-dot" aria-hidden="true" />
                        動作中
                      </span>
                    </div>
                    <div className="settings-detection-service-chips" aria-label="検出対象">
                      <span className="settings-detection-chip settings-detection-chip-active">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        Meet
                      </span>
                      <span className="settings-detection-chip settings-detection-chip-active">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        Zoom
                      </span>
                      <span className="settings-detection-chip settings-detection-chip-muted">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        Teams
                      </span>
                      <span className="settings-detection-chip settings-detection-chip-muted">
                        <span className="settings-detection-chip-dot" aria-hidden="true" />
                        URL
                      </span>
                    </div>
                    <div className="settings-detection-auto-row">
                      <span className="settings-detection-auto-label">
                        会議音声を検出したら自動開始
                      </span>
                      <span className="settings-detection-auto-switch" aria-hidden="true">
                        <span className="settings-detection-auto-knob" />
                      </span>
                    </div>
                  </div>

                  <div className="settings-readonly-card settings-detection-card">
                    <div className="settings-detection-card-head">
                      <div className="settings-detection-icon-box settings-detection-icon-box-small" aria-hidden="true">
                        <Type size={14} strokeWidth={2} />
                      </div>
                      <h3 className="settings-readonly-card-title">検出ルール</h3>
                    </div>
                    <div className="settings-detection-rule-tabs" aria-label="検出ルールの種類">
                      <span className="settings-detection-tab settings-detection-tab-active">URL</span>
                      <span className="settings-detection-tab">アプリ</span>
                      <span className="settings-detection-tab">ウィンドウ</span>
                      <span className="settings-detection-tab">音声</span>
                    </div>
                    <div className="settings-detection-rule-list">
                      <div className="settings-detection-rule-item settings-detection-rule-item-active">
                        <span className="settings-detection-rule-item-icon" aria-hidden="true">
                          <Search size={12} strokeWidth={2} />
                        </span>
                        <span className="settings-detection-rule-item-text">meet.google.com/*</span>
                        <span className="settings-detection-rule-item-remove" aria-hidden="true">
                          ×
                        </span>
                      </div>
                      <div className="settings-detection-rule-item">
                        <span className="settings-detection-rule-item-icon" aria-hidden="true">
                          <Mic size={12} strokeWidth={2} />
                        </span>
                        <span className="settings-detection-rule-item-text">
                          ループバックで音声が8秒以上継続
                        </span>
                        <span className="settings-detection-rule-item-remove" aria-hidden="true">
                          ×
                        </span>
                      </div>
                      <div className="settings-detection-rule-item settings-detection-rule-item-add">
                        <span className="settings-detection-rule-item-icon" aria-hidden="true">
                          ＋
                        </span>
                        <span className="settings-detection-rule-item-text">ルールを追加</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-log-card">
                    <div className="settings-detection-log-head">
                      <div className="settings-detection-icon-box settings-detection-icon-box-small" aria-hidden="true">
                        <Search size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">検出ログ</h3>
                        <p className="settings-detection-subtitle">最近の候補と判定理由</p>
                      </div>
                      <span className="settings-detection-live-badge">
                        <span className="settings-detection-live-dot" aria-hidden="true" />
                        ライブ
                      </span>
                    </div>
                    <div className="settings-detection-log-list">
                      <div className="settings-detection-log-entry">
                        <div className="settings-detection-log-entry-head">
                          <span className="settings-detection-log-entry-dot" aria-hidden="true" />
                          <span className="settings-detection-log-entry-title">meet.google.com URL一致</span>
                        </div>
                        <p>音声が14秒以上継続</p>
                      </div>
                      <div className="settings-detection-log-entry">
                        <div className="settings-detection-log-entry-head">
                          <span className="settings-detection-log-entry-dot" aria-hidden="true" />
                          <span className="settings-detection-log-entry-title">アプリ: zoom.us がフォアグラウンド</span>
                        </div>
                        <p>ループバック有効</p>
                      </div>
                      <div className="settings-detection-log-entry">
                        <div className="settings-detection-log-entry-head">
                          <span className="settings-detection-log-entry-dot settings-detection-log-entry-dot-warn" aria-hidden="true" />
                          <span className="settings-detection-log-entry-title">音声アクティビティしきい値未満</span>
                        </div>
                        <p>0.41 &lt; 0.82</p>
                      </div>
                    </div>
                    <div className="settings-detection-reason">
                      <div className="settings-detection-reason-head">
                        <span className="settings-detection-reason-icon" aria-hidden="true">
                          i
                        </span>
                        <span>判定の理由</span>
                      </div>
                      <p>
                        直近の採用は有効な3シグナル中2件と一致しました: URLパターン+ループバックの継続音声。アプリ名シグナルは判定保留ですが減点はしていません。
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "aiMinutes" && (
              <div className="settings-readonly-grid settings-readonly-grid-ai-minutes">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-ai-provider-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <Sparkles size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">AIプロバイダー</h3>
                        <p className="settings-detection-subtitle">
                          デフォルトはオフ。プロバイダーを選んでも生成を実行したときだけ送信されます。
                        </p>
                      </div>
                      <span
                        className="settings-detection-auto-switch"
                        role="status"
                        aria-label="AIプロバイダー: 有効"
                        title="AIプロバイダー: 有効"
                      >
                        <span className="settings-detection-auto-knob" aria-hidden="true" />
                      </span>
                    </div>
                    <div className="settings-ai-provider-list">
                      <div className="settings-ai-provider-item settings-ai-provider-item-selected">
                        <div className="settings-ai-provider-item-line">
                          <span className="settings-ai-provider-dot" aria-hidden="true" />
                          <span className="settings-ai-provider-title">
                            Anthropic・Claude Sonnet 4.6
                          </span>
                          <span className="settings-ai-provider-badge settings-ai-provider-badge-selected">
                            利用中
                          </span>
                        </div>
                        <span className="settings-ai-provider-desc">
                          APIキー設定済・30分の会議で約$0.012
                        </span>
                      </div>
                      <div className="settings-ai-provider-item">
                        <div className="settings-ai-provider-item-line">
                          <span className="settings-ai-provider-dot" aria-hidden="true" />
                          <span className="settings-ai-provider-title">OpenAI・GPT-4o</span>
                          <span className="settings-ai-provider-badge">未設定</span>
                        </div>
                        <span className="settings-ai-provider-desc">APIキーが必要・クラウド</span>
                      </div>
                      <div className="settings-ai-provider-item">
                        <div className="settings-ai-provider-item-line">
                          <span className="settings-ai-provider-dot" aria-hidden="true" />
                          <span className="settings-ai-provider-title">
                            ローカル・Ollama（llama3.1:8b）
                          </span>
                          <span className="settings-ai-provider-badge settings-ai-provider-badge-local">
                            ローカル
                          </span>
                        </div>
                        <span className="settings-ai-provider-desc">端末内処理・API費用なし</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-readonly-card settings-ai-template-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <LayoutTemplate size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">議事録テンプレート</h3>
                        <p className="settings-detection-subtitle">
                          AIに生成させるセクションを選びます。
                        </p>
                      </div>
                    </div>
                    <div className="settings-permission-row settings-ai-template-row">
                      <span className="settings-ai-template-row-icon" aria-hidden="true">
                        <Check size={13} strokeWidth={2.2} />
                      </span>
                      <span className="settings-permission-label">サマリー（3項目）</span>
                      <span
                        className="settings-ai-template-switch settings-ai-template-switch-on"
                        role="status"
                        aria-label="サマリー（3項目）: オン"
                        title="サマリー（3項目）: オン"
                      >
                        <span className="settings-ai-template-switch-knob" aria-hidden="true" />
                      </span>
                    </div>
                    <div className="settings-permission-row settings-ai-template-row">
                      <span className="settings-ai-template-row-icon" aria-hidden="true">
                        <ListChecks size={13} strokeWidth={2.2} />
                      </span>
                      <span className="settings-permission-label">
                        担当者付きアクションアイテム
                      </span>
                      <span
                        className="settings-ai-template-switch settings-ai-template-switch-on"
                        role="status"
                        aria-label="担当者付きアクションアイテム: オン"
                        title="担当者付きアクションアイテム: オン"
                      >
                        <span className="settings-ai-template-switch-knob" aria-hidden="true" />
                      </span>
                    </div>
                    <div className="settings-permission-row settings-ai-template-row">
                      <span className="settings-ai-template-row-icon" aria-hidden="true">
                        <Flag size={13} strokeWidth={2.2} />
                      </span>
                      <span className="settings-permission-label">決定事項</span>
                      <span
                        className="settings-ai-template-switch settings-ai-template-switch-off"
                        role="status"
                        aria-label="決定事項: オフ"
                        title="決定事項: オフ"
                      >
                        <span className="settings-ai-template-switch-knob" aria-hidden="true" />
                      </span>
                    </div>
                  </div>
                </div>
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-ai-runs-card">
                    <div className="settings-detection-head">
                      <div className="settings-detection-icon-box" aria-hidden="true">
                        <History size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">最近の実行履歴</h3>
                        <p className="settings-detection-subtitle">
                          各実行にはコストとプロバイダー付きで記録されます。
                        </p>
                      </div>
                      <span className="settings-detection-live-badge">
                        <span className="settings-detection-live-dot" aria-hidden="true" />
                        7T
                      </span>
                    </div>
                    <div className="settings-ai-runs-list">
                      <div className="settings-ai-run-item">
                        <div className="settings-ai-run-item-head">
                          <span className="settings-ai-run-date">週次定例・4月28日</span>
                          <span className="settings-ai-run-status settings-ai-run-status-ready">
                            完了
                          </span>
                        </div>
                        <div className="settings-ai-run-item-body">
                          <span className="settings-ai-run-model">Claude Sonnet 4.6</span>
                          <span className="settings-ai-run-cost">1,842トークン · $0.011</span>
                        </div>
                      </div>
                      <div className="settings-ai-run-item">
                        <div className="settings-ai-run-item-head">
                          <span className="settings-ai-run-date">Meiとの1on1・4月27日</span>
                          <span className="settings-ai-run-status settings-ai-run-status-warn">
                            保留
                          </span>
                        </div>
                        <div className="settings-ai-run-item-body">
                          <span className="settings-ai-run-cost">
                            同意待ち・文字起こしはローカル保存中
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="settings-ai-runs-summary">
                      <span className="settings-ai-runs-summary-label">4月の利用額</span>
                      <span className="settings-ai-runs-summary-value">$0.42 / 上限$5</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 保存ボタン */}
            {shouldShowSettingsActions && (
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
            )}
          </main>
        </div>
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
      STATUS_UNCHECKABLE_LABEL,
      false,
      `${STATUS_UNCHECKABLE_LABEL}: ${toErrorMessage(error)}`,
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
  return renderBadge("permission-undetermined", STATUS_UNDETERMINED_LABEL);
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
    ? STATUS_CHECKING_LABEL
    : hasKeyError
      ? STATUS_UNCHECKABLE_LABEL
      : hasKey === undefined
        ? STATUS_CHECKING_LABEL
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
