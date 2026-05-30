import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mic,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Type,
  type LucideIcon,
} from "lucide-react";
import { AudioLevelMeter } from "../components/AudioLevelMeter";
import type {
  AiMinutesProvider,
  AppSettings,
  AudioDevice,
  MeetingDetectionService,
  TranscriptionEngineType,
} from "../types";
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
import {
  MACOS_ACCESSIBILITY_PRIVACY_URL,
  MACOS_MICROPHONE_PRIVACY_URL,
  MACOS_SCREEN_RECORDING_PRIVACY_URL,
  OPEN_ACCESSIBILITY_PRIVACY_LABEL,
  OPEN_MICROPHONE_PRIVACY_LABEL,
  OPEN_SCREEN_RECORDING_PRIVACY_LABEL,
} from "../utils/macosPrivacySettings";
import {
  STATUS_CHECKING_LABEL,
  STATUS_CHECKING_WITH_DOTS_LABEL,
  STATUS_DENIED_LABEL,
  STATUS_UNCHECKABLE_LABEL,
  STATUS_UNDETERMINED_LABEL,
  STATUS_UNREGISTERED_LABEL,
} from "../utils/statusLabels";
import type { SettingsCategoryKey } from "../utils/settingsWindow";
import { isTauriRuntime } from "../utils/browserRuntime";
import {
  PREVIEW_APP_SETTINGS,
  PREVIEW_AUDIO_DEVICES,
} from "../utils/previewAppData";

const WHISPER_MODELS = [
  { value: "tiny", label: "Tiny（最軽量）" },
  { value: "base", label: "Base（標準）" },
  { value: "small", label: "Small（軽量高精度）" },
  { value: "medium", label: "Medium（高精度）" },
  { value: "large-v3", label: "Large v3（最高精度）" },
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
  { value: "en", label: "英語" },
];

const AI_MINUTES_PROVIDER_OPTIONS: ReadonlyArray<{
  key: AiMinutesProvider;
  title: string;
  badge: string;
  description: string;
  transmission: "none" | "external" | "local";
}> = [
  {
    key: "anthropic",
    title: "Anthropic・Claude",
    badge: "手動コピー確認",
    description: "文字起こしと手書きメモを手動コピー時に確認",
    transmission: "external",
  },
  {
    key: "openAI",
    title: "OpenAI・GPT-4o",
    badge: "手動コピー確認",
    description: "文字起こしと手書きメモを手動コピー時に確認",
    transmission: "external",
  },
  {
    key: "ollama",
    title: "端末内・Ollama",
    badge: "端末内AI",
    description: "端末内生成、AI外部送信なし",
    transmission: "local",
  },
  {
    key: "none",
    title: "AI議事録オフ",
    badge: "AIオフ",
    description: "議事録AIだけオフ、録音と文字起こしは継続",
    transmission: "none",
  },
];

const DETECTION_SERVICE_OPTIONS: ReadonlyArray<{
  key: MeetingDetectionService;
  label: string;
  rule: string;
}> = [
  {
    key: "googleMeet",
    label: "Meet",
    rule: "meet.google.com/*",
  },
  {
    key: "zoom",
    label: "Zoom",
    rule: "zoom.us / Zoom.app",
  },
  {
    key: "teams",
    label: "Teams",
    rule: "teams.microsoft.com / Microsoft Teams",
  },
  {
    key: "faceTime",
    label: "FaceTime",
    rule: "FaceTime.app",
  },
  {
    key: "browserUrls",
    label: "その他URL",
    rule: "Webex / Whereby / GoTo",
  },
];

const DETECTION_SIGNAL_COUNT_OPTIONS = [1, 2, 3] as const;

const SETTINGS_CATEGORIES = [
  {
    key: "general",
    label: "一般",
    icon: Settings,
    kicker: "基本設定",
    title: "一般",
    subtitle: "録音・検出・送信範囲の入口を整えます。",
  },
  {
    key: "detection",
    label: "検出",
    icon: Search,
    kicker: "会議検出",
    title: "会議の検出",
    subtitle: "URL・アプリ・音声状態で検出し、通知から録音開始できます。",
  },
  {
    key: "audio",
    label: "音声",
    icon: Mic,
    kicker: "音声取得",
    title: "音声トラックを分離",
    subtitle: "自分と相手側を別トラックで扱います。",
  },
  {
    key: "transcription",
    label: "文字起こし",
    icon: Type,
    kicker: "リアルタイム文字起こし",
    title: "文字起こし",
    subtitle: "表示と保存を選びます。",
  },
  {
    key: "aiMinutes",
    label: "AI議事録",
    icon: Sparkles,
    kicker: "AI議事録",
    title: "AI議事録",
    subtitle: "生成プロバイダーを選びます。",
  },
  {
    key: "privacy",
    label: "プライバシー",
    icon: Shield,
    kicker: "透明性",
    title: "プライバシー",
    subtitle: "保存・送信・保持を決めます。",
  },
] satisfies ReadonlyArray<{
  key: SettingsCategoryKey;
  label: string;
  icon: LucideIcon;
  kicker: string;
  title: string;
  subtitle: string;
}>;

interface SettingsViewProps {
  initialCategory?: SettingsCategoryKey;
  windowVariant?: "embedded" | "standalone";
}

function syncLiveCaptionStatus(status: LiveCaptionStatusPayload): void {
  writeStoredLiveCaptionStatus(status, (e) => {
    console.error(
      "ライブ文字起こしステータスの保存に失敗しました:",
      toErrorMessage(e),
    );
  });
  if (!isTauriRuntime()) {
    return;
  }
  void emit(LIVE_CAPTION_STATUS_EVENT, status).catch((e) => {
    console.error(
      "ライブ文字起こしステータスの同期に失敗しました:",
      toErrorMessage(e),
    );
  });
}

export function SettingsView({
  initialCategory = "general",
  windowVariant = "embedded",
}: SettingsViewProps = {}) {
  const isBrowserPreview = !isTauriRuntime();
  const queryClient = useQueryClient();
  const [localSettings, setLocalSettings] = useState<AppSettings | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [permissionSettingsOpenError, setPermissionSettingsOpenError] =
    useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const lastSyncedSettingsRef = useRef<AppSettings | null>(null);
  const isSavingSettingsRef = useRef(false);
  const [activeCategory, setActiveCategory] =
    useState<SettingsCategoryKey>(initialCategory);

  const {
    data: settings,
    error: settingsError,
    isLoading: isLoadingSettings,
    isFetching: isFetchingSettings,
    refetch: refetchSettings,
  } = useQuery<AppSettings>({
    queryKey: ["settings", isBrowserPreview ? "browser-preview" : "tauri"],
    queryFn: () =>
      isBrowserPreview
        ? Promise.resolve(PREVIEW_APP_SETTINGS)
        : invoke<AppSettings>("get_settings"),
  });

  const {
    data: devices,
    error: devicesError,
    isFetching: isFetchingDevices,
    refetch: refetchDevices,
  } = useQuery<AudioDevice[]>({
    queryKey: ["audioDevices", isBrowserPreview ? "browser-preview" : "tauri"],
    queryFn: () =>
      isBrowserPreview
        ? Promise.resolve(PREVIEW_AUDIO_DEVICES)
        : invoke<AudioDevice[]>("list_audio_devices"),
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
      isBrowserPreview
        ? Promise.resolve(newSettings)
        : invoke("update_settings", { settings: newSettings }),
    onSuccess: (_data, savedSettings) => {
      syncLiveCaptionStatus(
        buildLiveCaptionStatusFromEngine(savedSettings.transcriptionEngine),
      );
      queryClient.setQueryData(
        ["settings", isBrowserPreview ? "browser-preview" : "tauri"],
        savedSettings,
      );
      if (!isBrowserPreview) {
        queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
      showToast("設定を保存しました");
    },
    onError: (error) => {
      console.error("設定の保存に失敗しました:", toErrorMessage(error));
      showToast("設定を保存できませんでした");
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

  useEffect(() => {
    setActiveCategory(initialCategory);
  }, [initialCategory]);

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
          aria-label="設定を読み込めませんでした"
          title={settingsErrorMessage}
        >
          設定を読み込めませんでした。
        </p>
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => refetchSettings()}
          disabled={isFetchingSettings}
          aria-label={reloadSettingsLabel}
          title={reloadSettingsLabel}
        >
          {isFetchingSettings ? "設定読み込み中…" : "設定を再読み込み"}
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
        設定読み込み中…
      </div>
    );
  }

  const hasChanges = JSON.stringify(localSettings) !== JSON.stringify(settings);
  const detectionRules = localSettings.detectionRules;
  const enabledDetectionServices = new Set(detectionRules.enabledServices);
  const enabledDetectionServiceLabels = DETECTION_SERVICE_OPTIONS.filter(
    (service) => enabledDetectionServices.has(service.key),
  ).map((service) => service.label);
  const detectionStatusLabel = detectionRules.enabled
    ? "通知オン"
    : "通知オフ";
  const detectionSignalRequirementLabel = detectionRules.requireAudioSignal
    ? `${detectionRules.minimumSignalCount}シグナル + 音声`
    : `${detectionRules.minimumSignalCount}シグナル一致`;
  const detectionOverviewDetail = detectionRules.enabled
    ? `${enabledDetectionServiceLabels.length}検出対象・${detectionSignalRequirementLabel}`
    : "検出通知はオフ";
  const detectionCardSubtitle =
    "URL・アプリ・音声状態で検出し、通知から録音開始できます。";
  const detectionServiceGroupLabel = `会議検出対象。${enabledDetectionServiceLabels.length}件が有効。検知した会議は通知から録音開始できます。`;
  const detectionRuleGroupLabel = `会議検出ルールの種類。現在は${detectionSignalRequirementLabel}で通知し、通知から録音開始できます。`;
  const detectionNotificationToggleLabel = `会議検出通知: ${detectionStatusLabel}。オンのときは検知通知から録音開始し、REC表示とライブ文字起こしへ進みます。`;
  const detectionRulePreviewLabel = `検出ルール: ${detectionSignalRequirementLabel}。条件一致時は通知ウィンドウを出し、通知から録音開始、REC表示、ライブ文字起こしへ進みます。`;
  const recordingStartRoutesLabel =
    "開始導線: 検知通知またはメニューバー録音から開始。開始後はREC表示、ライブ文字起こし、AIノート確認、このMac保存へ進みます。";
  const recordingStartRoutes = [
    { label: "検知通知", value: detectionStatusLabel, tone: "accent" },
    { label: "メニューバー", value: "手動録音", tone: "neutral" },
    { label: "開始後", value: "REC / 文字起こし", tone: "accent" },
    { label: "保存", value: "このMac", tone: "safe" },
  ] as const;
  const detectionSignalRuntimeNote =
    detectionRules.requireAudioSignal || detectionRules.minimumSignalCount >= 3
      ? "音声閾値を超えたときだけ通知します。"
      : "URL・アプリ・ウィンドウ一致で通知します。";
  const detectionSignalFlow = [
    {
      label: "対象",
      value: `${enabledDetectionServiceLabels.length}件`,
      tone: enabledDetectionServiceLabels.length > 0 ? "accent" : "muted",
    },
    {
      label: "一致",
      value: `${detectionRules.minimumSignalCount}シグナル`,
      tone: detectionRules.minimumSignalCount >= 3 ? "warn" : "accent",
    },
    {
      label: "音声",
      value: detectionRules.requireAudioSignal ? "必須" : "補助",
      tone: detectionRules.requireAudioSignal ? "warn" : "safe",
    },
    {
      label: "通知",
      value: detectionRules.enabled ? "録音確認" : "オフ",
      tone: detectionRules.enabled ? "safe" : "muted",
    },
  ] as const;
  const detectionSignalFlowLabel = [
    "会議検出シグナルの流れ",
    `検出対象 ${enabledDetectionServiceLabels.length} 件`,
    `${detectionSignalRequirementLabel}で通知判定`,
    detectionRules.requireAudioSignal
      ? "継続音声を必須シグナルとして扱います"
      : "継続音声は補助シグナルとして扱います",
    detectionRules.enabled
      ? "条件一致時は通知ウィンドウから録音開始できます"
      : "会議検出通知はオフです",
  ].join("。");
  const updateDetectionRules = (
    updater: (
      rules: AppSettings["detectionRules"],
    ) => AppSettings["detectionRules"],
  ) => {
    setLocalSettings((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        detectionRules: updater(current.detectionRules),
      };
    });
  };
  const toggleDetectionService = (service: MeetingDetectionService) => {
    updateDetectionRules((rules) => {
      const nextServices = new Set(rules.enabledServices);
      if (nextServices.has(service)) {
        nextServices.delete(service);
      } else {
        nextServices.add(service);
      }
      return {
        ...rules,
        enabledServices: DETECTION_SERVICE_OPTIONS.map(
          (option) => option.key,
        ).filter((key) => nextServices.has(key)),
      };
    });
  };
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
  const transcriptionEngineSummary =
    localSettings.transcriptionEngine === "whisper"
      ? `Whisper ${whisperModelName}`
      : localSettings.transcriptionEngine === "appleSpeech"
        ? "macOS SpeechAnalyzer"
        : localSettings.transcriptionEngine === "openAIRealtime"
          ? "OpenAI Realtime"
          : "ElevenLabs Realtime";
  const transcriptionTransmissionSummary =
    localSettings.transcriptionEngine === "openAIRealtime" ||
    localSettings.transcriptionEngine === "elevenLabsRealtime"
      ? "音声外部送信あり"
      : "端末内で文字起こし";
  const aiMinutesProvider = localSettings.aiMinutesProvider;
  const selectedAiMinutesProvider =
    AI_MINUTES_PROVIDER_OPTIONS.find(
      (provider) => provider.key === aiMinutesProvider,
    ) ?? AI_MINUTES_PROVIDER_OPTIONS[AI_MINUTES_PROVIDER_OPTIONS.length - 1];
  const aiMinutesProviderValue =
    selectedAiMinutesProvider.key === "none"
      ? "AI議事録オフ"
      : selectedAiMinutesProvider.title;
  const aiMinutesProviderDetail =
    selectedAiMinutesProvider.transmission === "external"
      ? "文字起こし+手書きメモを手動コピー時確認"
      : selectedAiMinutesProvider.transmission === "local"
        ? "端末内で生成"
        : "AI議事録オフ";
  const aiMinutesProviderCardLabel = [
    `AI議事録プロバイダー: ${aiMinutesProviderValue}`,
    aiMinutesProviderDetail,
    "録音後の議事録ワークスペースで文字起こしと手書きメモに使用",
    "選択だけでは送信しません",
    "音声トラックは送信しません",
  ].join("。");
  const aiMinutesTransparencyLabel =
    selectedAiMinutesProvider.transmission === "external"
      ? "手動コピー確認"
      : selectedAiMinutesProvider.transmission === "local"
        ? "端末内AI"
        : "AIオフ";
  const aiMinutesProviderTone =
    selectedAiMinutesProvider.transmission === "external"
      ? "warn"
      : selectedAiMinutesProvider.transmission === "local"
        ? "ready"
        : "safe";
  const aiMinutesMaterialSteps = [
    { label: "文字起こし", value: "履歴から", tone: "accent" },
    { label: "手書きメモ", value: "任意追加", tone: "neutral" },
    { label: "テンプレート", value: "録音後選択", tone: "neutral" },
    {
      label: "送信",
      value: aiMinutesTransparencyLabel,
      tone: aiMinutesProviderTone,
    },
  ] as const;
  const aiMinutesMaterialFlowLabel = [
    "AI議事録の素材フロー",
    "録音後の履歴詳細で文字起こし、手書きメモ、テンプレートを組み合わせます",
    `現在の送信境界は${aiMinutesTransparencyLabel}`,
    "音声トラックは送信しません",
  ].join("。");
  const settingsOverviewCards = [
    {
      label: "会議検出",
      value: detectionStatusLabel,
      tone: detectionRules.enabled ? "ready" : "muted",
      icon: Search,
      detail: detectionOverviewDetail,
    },
    {
      label: "マイク",
      value: selectedMicrophoneDeviceName,
      tone: "neutral",
      icon: Mic,
      detail: "自分トラックの入力",
    },
    {
      label: "録音範囲",
      value: "マイク + スピーカー",
      tone: "ready",
      icon: ShieldCheck,
      detail: "別トラック保存 / 音声非送信",
    },
    {
      label: "文字起こし",
      value: transcriptionEngineSummary,
      tone:
        localSettings.transcriptionEngine === "whisper" ? "ready" : "neutral",
      icon: Type,
      detail: transcriptionTransmissionSummary,
    },
    {
      label: "AI議事録",
      value: aiMinutesProviderValue,
      tone: aiMinutesProviderTone,
      icon: Sparkles,
      detail: aiMinutesProviderDetail,
    },
  ] as const;
  const whisperModelLabel = `Whisper モデル: ${whisperModelName}`;
  const transcriptionEngineCardLabel = [
    `文字起こしエンジン: ${transcriptionEngineSummary}`,
    "録音中のライブ文字起こしに使用",
    "自分/相手側トラックを時刻順に表示",
    transcriptionTransmissionSummary,
  ].join("。");
  const isExternalTranscriptionEngine =
    localSettings.transcriptionEngine === "openAIRealtime" ||
    localSettings.transcriptionEngine === "elevenLabsRealtime";
  const transcriptionEngineRuntimeFlow = [
    { label: "入力", value: "2トラック", tone: "accent" },
    {
      label: "エンジン",
      value:
        localSettings.transcriptionEngine === "whisper"
          ? "端末内"
          : localSettings.transcriptionEngine === "appleSpeech"
            ? "片側向け"
            : "Realtime",
      tone:
        localSettings.transcriptionEngine === "whisper"
          ? "safe"
          : isExternalTranscriptionEngine
            ? "warn"
            : "muted",
    },
    { label: "表示", value: "ライブ", tone: "accent" },
    {
      label: "送信",
      value: isExternalTranscriptionEngine ? "音声外部" : "外部送信なし",
      tone: isExternalTranscriptionEngine ? "warn" : "safe",
    },
  ] as const;
  const transcriptionEngineRuntimeFlowLabel = [
    "文字起こしエンジンの実行範囲",
    "入力は自分と相手側の2トラック",
    `選択中 ${transcriptionEngineSummary}`,
    "録音中にライブ表示します",
    isExternalTranscriptionEngine
      ? "音声を外部Realtimeへ送信します"
      : "音声外部送信なし",
  ].join("。");
  const microphoneDeviceLabel = localSettings.microphoneDeviceId
    ? `${SELF_TRACK_DEVICE_LABEL}のデバイス: ${selectedMicrophoneDeviceName}。録音時は自分トラックとして保存し、履歴詳細でマイクのみ/スピーカーのみ/両方を再生できます。`
    : `${SELF_TRACK_DEVICE_LABEL}のデバイス: デフォルト。録音時は自分トラックとして保存し、履歴詳細でマイクのみ/スピーカーのみ/両方を再生できます。`;
  const generalMicrophoneInputLabel = `${SELF_TRACK_DEVICE_LABEL}の入力デバイス: ${selectedMicrophoneDeviceName}。会議検知通知とメニューバー録音で自分トラックに使います。`;
  const retryDevicesLabel = isFetchingDevices
    ? `${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を取得中`
    : `${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を再取得`;
  const languageLabel = `文字起こし言語: ${languageName}`;
  const transcriptionCorrectionFlow = [
    { label: "言語", value: languageName, tone: "accent" },
    { label: "辞書", value: "未接続", tone: "warn" },
    { label: "補正", value: "後処理予定", tone: "muted" },
    { label: "議事録", value: "生成前候補", tone: "safe" },
  ] as const;
  const transcriptionCorrectionFlowLabel = [
    "文字起こし補正の状態",
    `現在の主言語は${languageName}`,
    "辞書補正は未接続です",
    "将来は履歴の文字起こし後処理と議事録生成前の補正候補として扱います",
    "音声トラックは補正や議事録のために外部送信しません",
  ].join("。");
  const devicesErrorMessage = devicesError ? toErrorMessage(devicesError) : "";
  const permissionSettingsOpenErrorLabel = permissionSettingsOpenError
    ? "macOS 設定を開けませんでした"
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
  const isSystemAudioCaptureReady = screenPermission === "granted";
  const systemAudioCaptureStateLabel = isFetchingScreenPermission
    ? "画面収録確認中"
    : screenPermissionError
      ? "画面収録確認失敗"
      : isSystemAudioCaptureReady
        ? "相手側音声取得可"
        : screenPermission === "denied"
          ? "権限なし"
          : "画面収録権限確認";
  const systemAudioSourceLabel = isSystemAudioCaptureReady
    ? "デスクトップ/会議アプリ音声"
    : "権限許可後に取得";
  const systemAudioTrackStateLabel = isSystemAudioCaptureReady
    ? "相手側として保存"
    : "未取得";
  const systemAudioStatusLabel = `相手側システム音声: ${systemAudioCaptureStateLabel}。${systemAudioSourceLabel}。${systemAudioTrackStateLabel}`;
  const recordingTracksCardLabel =
    "録音トラック。自分はマイク、相手側は画面収録またはシステム音声として分離保存します。履歴詳細でマイクのみ、スピーカーのみ、両方の音声トラックを再生できます。音声トラックは外部送信しません。";
  const isMicrophoneCaptureReady = micPermission === "granted";
  const microphoneTrackStateLabel = isFetchingMicPermission
    ? "確認中"
    : micPermissionError
      ? "確認失敗"
      : isMicrophoneCaptureReady
        ? "録音可"
        : "権限確認";
  const recordingTrackInputFlow = [
    {
      label: "自分",
      value: microphoneTrackStateLabel,
      tone: isMicrophoneCaptureReady ? "safe" : "warn",
    },
    {
      label: "相手側",
      value: systemAudioTrackStateLabel,
      tone: isSystemAudioCaptureReady ? "safe" : "warn",
    },
    { label: "保存", value: "別トラック", tone: "accent" },
    { label: "送信", value: "音声なし", tone: "safe" },
  ] as const;
  const recordingTrackInputFlowLabel = [
    "録音トラックの入力と保存範囲",
    `自分トラック ${microphoneTrackStateLabel}`,
    `相手側トラック ${systemAudioTrackStateLabel}`,
    "録音後はマイクのみ、スピーカーのみ、両方を再生できます",
    "音声トラックは外部送信しません",
  ].join("。");
  const recordingPreflightSteps = [
    {
      label: "入力",
      value: `${selectedMicrophoneDeviceName} / ${systemAudioTrackStateLabel}`,
    },
    {
      label: "検出",
      value: detectionRules.enabled
        ? `${enabledDetectionServiceLabels.length}対象`
        : "通知停止",
    },
    {
      label: "文字起こし",
      value: transcriptionTransmissionSummary,
    },
    {
      label: "議事録",
      value: aiMinutesProviderDetail,
    },
  ] as const;
  const recordingPreflightLabel = recordingPreflightSteps
    .map((step) => `${step.label}: ${step.value}`)
    .join("。");
  const transcriptionLifecycleSteps = [
    { label: "録音中", value: "ライブ表示", tone: "accent" },
    { label: "停止後", value: "履歴保存", tone: "safe" },
    { label: "再利用", value: "検索 / コピー", tone: "neutral" },
    {
      label: "議事録",
      value: aiMinutesTransparencyLabel,
      tone: aiMinutesProviderTone,
    },
  ] as const;
  const transcriptionLifecycleLabel = [
    "文字起こしの利用フロー",
    "録音中はライブ表示",
    "停止後は履歴へ保存",
    "履歴詳細で検索、コピー、音声トラック確認、議事録素材化ができます",
    "音声トラックはAI議事録へ送信しません",
  ].join("。");
  const unsavedSettingsLabel = "未保存の変更があります";
  const saveSettingsLabel = updateMutation.isPending
    ? "設定を保存中"
    : "変更した設定を保存";
  const whisperEngineLabel = "Whisper: 端末内、音声外部送信なし";
  const appleSpeechEngineLabel = "SpeechAnalyzer: 端末内、片側トラック向け";
  const openAIRealtimeEngineLabel =
    "OpenAI Realtime: 音声外部送信、APIキー確認";
  const elevenLabsRealtimeEngineLabel =
    "ElevenLabs Realtime: 音声外部送信、APIキー確認";
  const selectedExternalRealtimeProvider =
    localSettings.transcriptionEngine === "openAIRealtime"
      ? "OpenAI"
      : localSettings.transcriptionEngine === "elevenLabsRealtime"
        ? "ElevenLabs"
        : null;
  const externalRealtimeRiskLabel = selectedExternalRealtimeProvider
    ? `${selectedExternalRealtimeProvider} Realtime は音声を外部送信します。費用が発生する場合があります。`
    : null;
  const externalRealtimeRiskAriaLabel = externalRealtimeRiskLabel
    ? `${externalRealtimeRiskLabel} APIキーは再表示されません。`
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
    windowVariant === "standalone" ? "独立設定ウィンドウ" : null,
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
  const shouldShowSettingsActions = hasChanges || updateMutation.isPending;
  const openPrivacySettings = useCallback(
    (url: string, label: string) => {
      setPermissionSettingsOpenError(null);
      if (isBrowserPreview) {
        showToast(`${label}はブラウザプレビューでは開きません`);
        return;
      }
      void openUrl(url).catch((e) => {
        const msg = toErrorMessage(e);
        console.error(`${label}を開けませんでした:`, msg);
        setPermissionSettingsOpenError(msg);
      });
    },
    [isBrowserPreview, showToast],
  );
  const configuredOutputDirectory = localSettings.outputDirectory?.trim() ?? "";
  const outputDirectoryLabel =
    configuredOutputDirectory.length > 0
      ? configuredOutputDirectory
      : "デフォルト保存先";
  const outputDirectoryScopeLabel = `保存先: ${outputDirectoryLabel}。録音履歴、文字起こし、音声トラックをこのMacに保存します。AI外部送信とは関係ありません。`;
  const revealOutputDirectoryLabel = `保存場所をFinderで表示: ${outputDirectoryLabel}。録音履歴、文字起こし、音声トラックの保存場所を確認します。`;
  const localDataDiskUsageLabel =
    "ディスク使用量: 履歴画面で録音履歴、文字起こし、音声トラックの保存状況を確認します。";
  const localDataBulkDeleteLabel =
    "アプリ内一括削除なし。録音履歴、文字起こし、音声トラックは保存場所から確認し、削除は手動で行います。";
  const privacyLocalDataBoundarySteps = [
    { label: "保存", value: "録音 / 文字起こし", tone: "accent" },
    { label: "音声", value: "このMac", tone: "safe" },
    {
      label: "議事録",
      value: aiMinutesTransparencyLabel,
      tone: aiMinutesProviderTone,
    },
    { label: "除外", value: "音声トラック送信", tone: "muted" },
  ] as const;
  const privacyLocalDataBoundaryLabel = [
    "ローカルデータの保存と送信境界",
    "録音、文字起こし、音声トラックはこのMacに保存",
    `AI議事録は${aiMinutesTransparencyLabel}`,
    "音声トラックは送信しません",
  ].join("。");
  const handleRevealOutputDirectory = useCallback(async () => {
    if (isBrowserPreview) {
      showToast("保存先はブラウザプレビューでは開きません");
      return;
    }
    try {
      const directory =
        configuredOutputDirectory.length > 0
          ? configuredOutputDirectory
          : await invoke<string>("get_default_output_directory");
      await openPath(directory);
      showToast("保存場所を開きました");
    } catch (e) {
      console.error("保存場所を開けませんでした:", toErrorMessage(e));
      showToast("保存先を開けませんでした");
    }
  }, [configuredOutputDirectory, isBrowserPreview, showToast]);

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
          </div>
        </div>

        <div className="settings-window-body">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-brand" aria-label="Meet Jerky">
              <span className="settings-sidebar-brand-icon" aria-hidden="true">
                <Mic size={16} strokeWidth={2.2} />
              </span>
              <span className="settings-sidebar-brand-name">Meet Jerky</span>
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
                    <span
                      className="settings-sidebar-item-icon"
                      aria-hidden="true"
                    >
                      <ItemIcon size={16} strokeWidth={2} />
                    </span>
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main
            className="settings-main-pane"
            aria-labelledby={activeCategoryTitleId}
          >
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
            <div
              className="settings-overview-strip"
              aria-label="主要設定の現在値"
            >
              {settingsOverviewCards.map((card) => {
                const OverviewIcon = card.icon;
                return (
                  <button
                    key={card.label}
                    type="button"
                    className={`settings-overview-card settings-overview-card-${card.tone}`}
                    onClick={() => {
                      if (card.label === "会議検出") {
                        setActiveCategory("detection");
                      } else if (card.label === "マイク") {
                        setActiveCategory("audio");
                      } else if (card.label === "録音範囲") {
                        setActiveCategory("privacy");
                      } else if (card.label === "文字起こし") {
                        setActiveCategory("transcription");
                      } else {
                        setActiveCategory("aiMinutes");
                      }
                    }}
                    aria-label={`${card.label}: ${card.value}。${card.detail}`}
                    title={`${card.label}: ${card.value}。${card.detail}`}
                  >
                    <span className="settings-overview-icon" aria-hidden="true">
                      <OverviewIcon size={14} strokeWidth={2.1} />
                    </span>
                    <span className="settings-overview-copy">
                      <span className="settings-overview-label">
                        {card.label}
                      </span>
                      <strong>{card.value}</strong>
                      <small>{card.detail}</small>
                    </span>
                  </button>
                );
              })}
            </div>
            <div
              className="settings-preflight-strip"
              role="status"
              aria-label={`録音前チェック。${recordingPreflightLabel}`}
              title={`録音前チェック。${recordingPreflightLabel}`}
            >
              <span className="settings-preflight-kicker">録音前チェック</span>
              <div className="settings-preflight-steps">
                {recordingPreflightSteps.map((step) => (
                  <span className="settings-preflight-step" key={step.label}>
                    <span>{step.label}</span>
                    <strong>{step.value}</strong>
                  </span>
                ))}
              </div>
            </div>
            {activeCategory === "transcription" && (
              <div className="settings-readonly-grid settings-readonly-grid-transcription">
                <div className="settings-readonly-column">
                  <div
                    className="settings-readonly-card settings-transcription-engine-card"
                    aria-label={transcriptionEngineCardLabel}
                    title={transcriptionEngineCardLabel}
                  >
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Type size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          文字起こしエンジン
                        </h3>
                        <p className="settings-detection-subtitle">
                          録音中のライブ文字起こしに使います。端末内優先。
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
                      <label
                        className="settings-radio-label"
                        title={whisperEngineLabel}
                      >
                        <input
                          type="radio"
                          name="engine"
                          value="whisper"
                          aria-describedby={ENGINE_NOTE_IDS.whisper}
                          checked={
                            localSettings.transcriptionEngine === "whisper"
                          }
                          onChange={() =>
                            setLocalSettings((current) =>
                              current
                                ? {
                                    ...current,
                                    transcriptionEngine:
                                      "whisper" as TranscriptionEngineType,
                                  }
                                : current,
                            )
                          }
                        />
                        <span>端末内 (Whisper)</span>
                        <span
                          id={ENGINE_NOTE_IDS.whisper}
                          className="settings-note"
                        >
                          端末内のみ、音声外部送信なし
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
                          checked={
                            localSettings.transcriptionEngine === "appleSpeech"
                          }
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
                        <span
                          id={ENGINE_NOTE_IDS.appleSpeech}
                          className="settings-note"
                        >
                          端末内のみ、macOS 26+、片側トラック向け
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
                          checked={
                            localSettings.transcriptionEngine ===
                            "openAIRealtime"
                          }
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
                        <span>OpenAI Realtime</span>
                        <span
                          id={ENGINE_NOTE_IDS.openAIRealtime}
                          className="settings-note"
                        >
                          音声外部送信、APIキー確認
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
                          checked={
                            localSettings.transcriptionEngine ===
                            "elevenLabsRealtime"
                          }
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
                        <span>ElevenLabs Realtime</span>
                        <span
                          id={ENGINE_NOTE_IDS.elevenLabsRealtime}
                          className="settings-note"
                        >
                          音声外部送信、APIキー確認
                        </span>
                      </label>
                    </div>
                    <div
                      className="settings-transcription-engine-flow"
                      role="status"
                      aria-label={transcriptionEngineRuntimeFlowLabel}
                      title={transcriptionEngineRuntimeFlowLabel}
                    >
                      {transcriptionEngineRuntimeFlow.map((step) => (
                        <span
                          key={`${step.label}-${step.value}`}
                          className={`settings-transcription-engine-flow-step settings-transcription-engine-flow-step-${step.tone}`}
                        >
                          <span>{step.label}</span>
                          <strong>{step.value}</strong>
                        </span>
                      ))}
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
                        APIキーは再表示されません。
                      </p>
                    )}
                    {localSettings.transcriptionEngine === "appleSpeech" && (
                      <p
                        id={APPLE_SPEECH_LIMIT_NOTE_ID}
                        className="settings-risk-note"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        aria-label="Apple Speech は片側トラック向けです。"
                        title="Apple Speech は片側トラック向けです。"
                      >
                        Apple Speechは片側トラックのみです。
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
                  {localSettings.transcriptionEngine ===
                    "elevenLabsRealtime" && (
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
                            current
                              ? { ...current, whisperModel: e.target.value }
                              : current,
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
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Type size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          文字起こし言語
                        </h3>
                        <p className="settings-detection-subtitle">
                          文字起こしの主言語を選びます。
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
                            current
                              ? { ...current, language: e.target.value }
                              : current,
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
                    <div className="settings-transcription-glossary-label">
                      辞書補正
                    </div>
                    <div
                      className="settings-transcription-glossary-state"
                      role="status"
                      aria-label="辞書補正は未接続です。現在は言語設定だけを保存します。将来は履歴の文字起こし後処理に反映します。"
                      title="辞書補正は未接続です。現在は言語設定だけを保存します。将来は履歴の文字起こし後処理に反映します。"
                    >
                      <span>辞書未接続</span>
                      <small>言語設定だけ保存</small>
                    </div>
                    <div
                      className="settings-transcription-correction-state"
                      role="status"
                      aria-label="後処理補正は未接続です。履歴の文字起こしと議事録生成前の補正候補として扱います。"
                      title="後処理補正は未接続です。履歴の文字起こしと議事録生成前の補正候補として扱います。"
                    >
                      <span>後処理補正</span>
                      <small>履歴・議事録前に反映予定</small>
                    </div>
                    <div
                      className="settings-transcription-correction-flow"
                      role="status"
                      aria-label={transcriptionCorrectionFlowLabel}
                      title={transcriptionCorrectionFlowLabel}
                    >
                      {transcriptionCorrectionFlow.map((item) => (
                        <span
                          key={`${item.label}-${item.value}`}
                          className={`settings-transcription-correction-flow-step settings-transcription-correction-flow-step-${item.tone}`}
                        >
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-transcription-output-card">
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Type size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          出力とタイミング
                        </h3>
                        <p className="settings-detection-subtitle">
                          表示と保存を選びます。
                        </p>
                      </div>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        録音中はライブ文字起こしを表示
                      </span>
                      <span
                        className="settings-permission-badge permission-manual"
                        role="status"
                        aria-label="ライブ文字起こし表示: オン。録音中にフローティングウィンドウへ表示します。"
                        title="ライブ文字起こし表示: オン。録音中にフローティングウィンドウへ表示します。"
                      >
                        <span
                          className="settings-permission-manual-dot"
                          aria-hidden="true"
                        />
                        オン
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        話者を分離（自分／相手）
                      </span>
                      <span
                        className="settings-permission-badge permission-manual"
                        role="status"
                        aria-label="話者分離: オン。自分トラックと相手側トラックを分けて表示します。"
                        title="話者分離: オン。自分トラックと相手側トラックを分けて表示します。"
                      >
                        <span
                          className="settings-permission-manual-dot"
                          aria-hidden="true"
                        />
                        オン
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        停止時に文字起こしを自動保存
                      </span>
                      <span
                        className="settings-permission-badge permission-manual"
                        role="status"
                        aria-label="自動保存: オン。録音停止時に文字起こし履歴へ保存します。"
                        title="自動保存: オン。録音停止時に文字起こし履歴へ保存します。"
                      >
                        <span
                          className="settings-permission-manual-dot"
                          aria-hidden="true"
                        />
                        オン
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        音声トラック再生
                      </span>
                      <span
                        className="settings-permission-badge"
                        role="status"
                        aria-label="音声トラック再生: 履歴詳細でマイクのみ、スピーカーのみ、両方を確認できます。"
                        title="音声トラック再生: 履歴詳細でマイクのみ、スピーカーのみ、両方を確認できます。"
                      >
                        履歴で再生
                      </span>
                    </div>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        書き出し形式
                      </span>
                      <div
                        className="settings-output-format-state"
                        role="status"
                        aria-label="書き出し形式は履歴の文字起こしです。VTT、SRT、JSON は未接続です。"
                        title="書き出し形式は履歴の文字起こしです。VTT、SRT、JSON は未接続です。"
                      >
                        <span className="settings-privacy-option settings-privacy-option-active">
                          履歴の文字起こし
                        </span>
                        <small>VTT / SRT / JSON は未接続</small>
                      </div>
                    </div>
                    <div
                      className="settings-transcription-lifecycle"
                      role="status"
                      aria-label={transcriptionLifecycleLabel}
                      title={transcriptionLifecycleLabel}
                    >
                      {transcriptionLifecycleSteps.map((step) => (
                        <span
                          key={`${step.label}-${step.value}`}
                          className={`settings-transcription-lifecycle-step settings-transcription-lifecycle-step-${step.tone}`}
                        >
                          <span>{step.label}</span>
                          <strong>{step.value}</strong>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div
                    className="settings-readonly-card settings-transcription-translation-card"
                    aria-label="リアルタイム翻訳。現在は原文のみ保持、端末内。"
                    title="リアルタイム翻訳。現在は原文のみ保持、端末内。"
                  >
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Sparkles size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          リアルタイム翻訳
                        </h3>
                        <p className="settings-detection-subtitle">
                          翻訳エンジン接続後に切り替えます。
                        </p>
                      </div>
                      <span className="settings-detection-live-badge settings-detection-live-badge-muted">
                        <span
                          className="settings-detection-live-dot"
                          aria-hidden="true"
                        />
                        原文のみ
                      </span>
                    </div>
                    <div className="settings-transcription-translation-grid">
                      <span>
                        <strong>原文</strong>
                        自動検出を保持
                      </span>
                      <span>
                        <strong>翻訳先</strong>
                        原文のみ
                      </span>
                      <span>
                        <strong>エンジン</strong>
                        翻訳未接続
                      </span>
                      <span>
                        <strong>翻訳外部送信</strong>
                        翻訳外部送信なし
                      </span>
                    </div>
                    <p
                      className="settings-translation-runtime-note"
                      role="status"
                      aria-label="リアルタイム翻訳エンジンは未接続です。録音中は原文のみ表示します。"
                      title="リアルタイム翻訳エンジンは未接続です。録音中は原文のみ表示します。"
                    >
                      翻訳未接続。録音中は原文のみ表示します。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "audio" && (
              <div className="settings-readonly-grid settings-readonly-grid-audio">
                <div className="settings-readonly-column">
                  <div className="settings-section">
                    <h3 className="settings-section-title">
                      自分トラックのマイク
                    </h3>
                    <select
                      aria-label={microphoneDeviceLabel}
                      title={microphoneDeviceLabel}
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
                        aria-label={`${SELF_TRACK_DEVICE_LABEL}のデバイス一覧を取得できません`}
                        title={devicesErrorMessage}
                      >
                        <span>マイク一覧を取得できません。</span>
                        <button
                          type="button"
                          className="control-btn control-btn-clear"
                          onClick={() => refetchDevices()}
                          disabled={isFetchingDevices}
                          aria-label={retryDevicesLabel}
                          title={retryDevicesLabel}
                        >
                          {isFetchingDevices
                            ? "マイク一覧取得中…"
                            : "マイク一覧を再取得"}
                        </button>
                      </div>
                    )}
                  </div>

                  <div
                    className="settings-readonly-card settings-audio-system-card"
                    aria-label={systemAudioStatusLabel}
                    title={systemAudioStatusLabel}
                  >
                    <h3 className="settings-readonly-card-title">
                      相手側システム音声
                    </h3>
                    <div
                      className="settings-audio-system-status"
                      aria-label={systemAudioStatusLabel}
                    >
                      <span
                        className={`settings-audio-system-chip ${
                          isSystemAudioCaptureReady
                            ? "settings-audio-system-chip-ready"
                            : "settings-audio-system-chip-muted"
                        }`}
                      >
                        <strong>画面収録</strong>
                        {systemAudioCaptureStateLabel}
                      </span>
                      <span
                        className={`settings-audio-system-chip ${
                          isSystemAudioCaptureReady
                            ? ""
                            : "settings-audio-system-chip-muted"
                        }`}
                      >
                        <strong>音源</strong>
                        {systemAudioSourceLabel}
                      </span>
                      <span
                        className={`settings-audio-system-chip ${
                          isSystemAudioCaptureReady
                            ? "settings-audio-system-chip-ready"
                            : "settings-audio-system-chip-muted"
                        }`}
                      >
                        <strong>トラック</strong>
                        {systemAudioTrackStateLabel}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="settings-readonly-column">
	                  <div
	                    className="settings-readonly-card"
	                    aria-label={recordingTracksCardLabel}
	                    title={recordingTracksCardLabel}
	                  >
                    <h3 className="settings-readonly-card-title">
                      録音トラック
                    </h3>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          自分音声
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
                          相手側音声
                        </span>
                        <PermissionBadge
                          label={`${OTHER_TRACK_PERMISSION_LABEL} macOS 画面収録権限`}
                          status={screenPermission}
                          error={screenPermissionError}
                          isChecking={isFetchingScreenPermission}
                        />
                      </div>
                    </div>
                    <div
                      className="settings-recording-track-flow"
                      role="status"
                      aria-label={recordingTrackInputFlowLabel}
                      title={recordingTrackInputFlowLabel}
                    >
                      {recordingTrackInputFlow.map((step) => (
                        <span
                          key={`${step.label}-${step.value}`}
                          className={`settings-recording-track-flow-step settings-recording-track-flow-step-${step.tone}`}
                        >
                          <span>{step.label}</span>
                          <strong>{step.value}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "general" && (
              <div className="settings-readonly-grid settings-readonly-grid-detection">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-card">
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Search size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          会議の検出
                        </h3>
                        <p className="settings-detection-subtitle">
                          {detectionCardSubtitle}
                        </p>
                      </div>
                      <span className="settings-detection-status">
                        <span
                          className={
                            detectionRules.enabled
                              ? "settings-detection-status-dot"
                              : "settings-detection-status-dot settings-detection-status-dot-muted"
                          }
                          aria-hidden="true"
                        />
                        {detectionStatusLabel}
                      </span>
                    </div>
                    <div
                      className="settings-detection-service-chips"
                      aria-label={detectionServiceGroupLabel}
                      title={detectionServiceGroupLabel}
                    >
                      {DETECTION_SERVICE_OPTIONS.map((service) => {
                        const isEnabled = enabledDetectionServices.has(
                          service.key,
                        );
                        return (
                          <button
                            type="button"
                            key={service.key}
                            className={
                              isEnabled
                                ? "settings-detection-chip settings-detection-chip-active"
                                : "settings-detection-chip settings-detection-chip-muted"
                            }
                            onClick={() => setActiveCategory("detection")}
                            aria-label={`${service.label}: ${isEnabled ? "検出対象" : "対象外"}。検出設定を開く`}
                            title={`${service.label}: ${isEnabled ? "検出対象" : "対象外"}`}
                          >
                            <span
                              className="settings-detection-chip-dot"
                              aria-hidden="true"
                            />
                            {service.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="settings-detection-auto-row">
                      <span className="settings-detection-auto-label">
                        検出した会議を通知で確認
                      </span>
                      <span
                        className={
                          detectionRules.enabled
                            ? "settings-detection-auto-switch"
                            : "settings-detection-auto-switch settings-detection-auto-switch-off"
                        }
                        role="status"
                        aria-label={detectionNotificationToggleLabel}
                        title={`${detectionNotificationToggleLabel} ${detectionOverviewDetail}`}
                      >
                        <span className="settings-detection-auto-knob" />
                      </span>
                    </div>
                    <div
                      className="settings-start-route-strip"
                      role="status"
                      aria-label={recordingStartRoutesLabel}
                      title={recordingStartRoutesLabel}
                    >
                      {recordingStartRoutes.map((route) => (
                        <span
                          className={`settings-start-route-chip settings-start-route-chip-${route.tone}`}
                          key={`${route.label}-${route.value}`}
                        >
                          <span>{route.label}</span>
                          <strong>{route.value}</strong>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="settings-readonly-card settings-detection-card settings-general-audio-card">
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Mic size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title settings-general-audio-title">
                          音声トラックを分離
                        </h3>
                        <p className="settings-detection-subtitle">
                          自分と相手側を別トラックで扱います。
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
                              自分トラック · 通知/メニュー録音
                            </p>
                          </div>
                        </div>
                        <select
                          aria-label={generalMicrophoneInputLabel}
                          title={generalMicrophoneInputLabel}
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
                          <option value="">デフォルト</option>
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
                              {systemAudioSourceLabel}
                            </p>
                          </div>
                        </div>
                        <select
                          aria-label={systemAudioStatusLabel}
                          title={systemAudioStatusLabel}
                          defaultValue="meeting-apps"
                          disabled
                          className="settings-select"
                        >
                          <option value="meeting-apps">
                            {isSystemAudioCaptureReady
                              ? "取得可能: 会議アプリ音声"
                              : "権限許可後に取得"}
                          </option>
                        </select>
                      </div>
                    </div>
                    <div className="settings-general-meter-row">
                      <span className="settings-general-meter-label">
                        自分音声
                      </span>
                      <div className="settings-general-meter-bar">
                        <AudioLevelMeter
                          level={0}
                          label="自分トラックは設定画面では待機中"
                        />
                      </div>
                      <span className="settings-general-meter-state">
                        設定待機
                      </span>
                    </div>
                    <div className="settings-general-meter-row">
                      <span className="settings-general-meter-label">
                        相手側音声
                      </span>
                      <div className="settings-general-meter-bar">
                        <AudioLevelMeter
                          level={0}
                          label="相手側トラックは設定画面では待機中"
                        />
                      </div>
                      <span className="settings-general-meter-state">
                        設定待機
                      </span>
                    </div>
                  </div>
                </div>

                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-log-card settings-general-transparency-card">
                    <div className="settings-detection-log-head">
                      <div
                        className="settings-detection-icon-box settings-detection-icon-box-small"
                        aria-hidden="true"
                      >
                        <Shield size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          録音の透明性
                        </h3>
                        <p className="settings-detection-subtitle">
                          録音状態を常に表示します。
                        </p>
                      </div>
                    </div>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          マイク
                        </span>
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
                                ? STATUS_DENIED_LABEL
                                : STATUS_UNDETERMINED_LABEL}
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          システム音声
                        </span>
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
                                ? STATUS_DENIED_LABEL
                                : STATUS_UNDETERMINED_LABEL}
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          AI議事録
                        </span>
                        <span className="settings-permission-badge permission-manual">
                          <span
                            className="settings-permission-manual-dot"
                            aria-hidden="true"
                          />
                          {aiMinutesTransparencyLabel}
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
                    <h3 className="settings-readonly-card-title">
                      データ保持期間
                    </h3>
                    <div className="settings-permission-row">
                      <span className="settings-permission-label">
                        保持期間
                      </span>
                      <div className="settings-privacy-option-group">
                        <span className="settings-privacy-option settings-privacy-option-active">
                          7日
                        </span>
                        <span className="settings-privacy-option">30日</span>
                        <span className="settings-privacy-option">90日</span>
                        <span className="settings-privacy-option">
                          削除しない
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">
                      ローカルデータ
                    </h3>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          AI外部送信
                        </span>
                        <span
                          className="settings-privacy-storage-badge"
                          role="status"
                          aria-label="AI外部送信: 設定だけでは送信せず、手動コピー時に確認"
                          title="AI外部送信: 設定だけでは送信せず、手動コピー時に確認"
                        >
                          手動コピー確認
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          ディスク使用量
                        </span>
                        <span
                          className="settings-privacy-storage-badge"
                          role="status"
                          aria-label={localDataDiskUsageLabel}
                          title={localDataDiskUsageLabel}
                        >
                          履歴画面で確認
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          保存先
                        </span>
                        <span
                          className="settings-privacy-storage-badge"
                          role="status"
                          aria-label={outputDirectoryScopeLabel}
                          title={outputDirectoryScopeLabel}
                        >
                          {outputDirectoryLabel}
                        </span>
	                      </div>
	                    </div>
	                    <div
	                      className="settings-privacy-local-flow"
	                      role="status"
	                      aria-label={privacyLocalDataBoundaryLabel}
	                      title={privacyLocalDataBoundaryLabel}
	                    >
	                      {privacyLocalDataBoundarySteps.map((step) => (
	                        <span
	                          key={`${step.label}-${step.value}`}
	                          className={`settings-privacy-local-chip settings-privacy-local-chip-${step.tone}`}
	                        >
	                          <span>{step.label}</span>
	                          <strong>{step.value}</strong>
	                        </span>
	                      ))}
	                    </div>
	                    <div className="settings-permission-actions">
	                      <button
                        type="button"
                        className="control-btn control-btn-clear"
                        onClick={() => void handleRevealOutputDirectory()}
                          aria-label={revealOutputDirectoryLabel}
                          title={revealOutputDirectoryLabel}
                        >
                        保存場所表示
                      </button>
                      <span
                        className="settings-privacy-storage-badge"
                        role="status"
                        aria-label={localDataBulkDeleteLabel}
                        title={localDataBulkDeleteLabel}
                      >
                        一括削除なし
                      </span>
                    </div>
                    <p
                      className="settings-privacy-storage-note"
                      role="status"
                      aria-label="保存先は保存場所から確認できます。アプリ内一括削除は実行しません。"
                      title="保存先は保存場所から確認できます。アプリ内一括削除は実行しません。"
                    >
                      保存先は保存場所から確認できます。アプリ内一括削除は実行しません。
                    </p>
                  </div>
                  <div
                    className="settings-readonly-card settings-privacy-scope-card"
                    aria-label="保存と送信範囲。録音、文字起こし、議事録はこのMacに保存し、議事録プロンプトは手動コピー時に確認、音声トラックは送信しません。"
                    title="保存と送信範囲: このMac保存、手動コピー確認、音声トラック送信なし"
                  >
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Shield size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          保存と送信範囲
                        </h3>
                      </div>
                      <span className="settings-detection-live-badge">
                        <span
                          className="settings-detection-live-dot"
                          aria-hidden="true"
                        />
                        手動コピー確認
                      </span>
                    </div>
                    <div className="settings-privacy-scope-grid">
                      <span className="settings-privacy-scope-item settings-privacy-scope-item-local">
                        <strong>このMac</strong>
                        録音 / 文字起こし / 議事録
                      </span>
                      <span className="settings-privacy-scope-item settings-privacy-scope-item-candidate">
                        <strong>手動コピー時に確認</strong>
                        議事録プロンプトの文字起こし / 手書きメモ
                      </span>
                      <span className="settings-privacy-scope-item settings-privacy-scope-item-muted">
                        <strong>送信しない</strong>
                        音声トラック
                      </span>
                    </div>
                  </div>
                </div>
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">
                      システム権限
                    </h3>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          マイク
                        </span>
                        <PermissionBadge
                          label={`${SELF_TRACK_DEVICE_LABEL} macOS マイク権限`}
                          status={micPermission}
                          error={micPermissionError}
                          isChecking={isFetchingMicPermission}
                        />
                        <button
                          type="button"
                          className="control-btn control-btn-clear"
                          onClick={() =>
                            openPrivacySettings(
                              MACOS_MICROPHONE_PRIVACY_URL,
                              "マイク権限設定",
                            )
                          }
                          aria-label={OPEN_MICROPHONE_PRIVACY_LABEL}
                          title={OPEN_MICROPHONE_PRIVACY_LABEL}
                        >
                          マイク設定を開く
                        </button>
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
                        <button
                          type="button"
                          className="control-btn control-btn-clear"
                          onClick={() =>
                            openPrivacySettings(
                              MACOS_SCREEN_RECORDING_PRIVACY_URL,
                              "画面収録設定",
                            )
                          }
                          aria-label={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
                          title={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
                        >
                          画面収録設定を開く
                        </button>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          アクセシビリティ
                        </span>
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
                        <button
                          type="button"
                          className="control-btn control-btn-clear"
                          onClick={() =>
                            openPrivacySettings(
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
                    </div>
                    {permissionSettingsOpenErrorLabel && (
                      <p
                        className="permission-banner-inline-error"
                        role="alert"
                        aria-label={permissionSettingsOpenErrorLabel}
                        title={permissionSettingsOpenErrorLabel}
                      >
                        {permissionSettingsOpenErrorLabel}
                      </p>
                    )}
                  </div>
                  <div className="settings-readonly-card">
                    <h3 className="settings-readonly-card-title">診断送信</h3>
                    <div className="settings-permissions">
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          匿名利用統計
                        </span>
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
                        <span
                          className="settings-privacy-state-label"
                          aria-hidden="true"
                        >
                          オフ
                        </span>
                      </div>
                      <div className="settings-permission-row">
                        <span className="settings-permission-label">
                          クラッシュレポート
                        </span>
                        <span
                          className="settings-privacy-switch settings-privacy-switch-off"
                          role="status"
                          aria-label="クラッシュレポート: オフ"
                          title="クラッシュレポート: オフ"
                        >
                          <span
                            className="settings-privacy-switch-knob"
                            aria-hidden="true"
                          />
                        </span>
                        <span
                          className="settings-privacy-state-label"
                          aria-hidden="true"
                        >
                          オフ
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "detection" && (
              <div className="settings-readonly-grid settings-readonly-grid-detection">
                <div className="settings-readonly-column">
                  <div className="settings-readonly-card settings-detection-card">
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Search size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          会議の検出
                        </h3>
                        <p className="settings-detection-subtitle">
                          {detectionCardSubtitle}
                        </p>
                      </div>
                      <span className="settings-detection-status">
                        <span
                          className={
                            detectionRules.enabled
                              ? "settings-detection-status-dot"
                              : "settings-detection-status-dot settings-detection-status-dot-muted"
                          }
                          aria-hidden="true"
                        />
                        {detectionStatusLabel}
                      </span>
                    </div>
                    <div
                      className="settings-detection-service-chips"
                      aria-label={detectionServiceGroupLabel}
                      title={detectionServiceGroupLabel}
                    >
                      {DETECTION_SERVICE_OPTIONS.map((service) => {
                        const isEnabled = enabledDetectionServices.has(
                          service.key,
                        );
                        return (
                          <button
                            key={service.key}
                            type="button"
                            className={
                              isEnabled
                                ? "settings-detection-chip settings-detection-chip-active"
                                : "settings-detection-chip settings-detection-chip-muted"
                            }
                            onClick={() => toggleDetectionService(service.key)}
                            aria-pressed={isEnabled}
                            title={`${service.label}: ${isEnabled ? "検出対象" : "対象外"}`}
                          >
                            <span
                              className="settings-detection-chip-dot"
                              aria-hidden="true"
                            />
                            {service.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="settings-detection-auto-row">
                      <span className="settings-detection-auto-label">
                        検出した会議を通知で確認
                      </span>
                      <button
                        type="button"
                        className={
                          detectionRules.enabled
                            ? "settings-detection-auto-switch"
                            : "settings-detection-auto-switch settings-detection-auto-switch-off"
                        }
                        onClick={() =>
                          updateDetectionRules((rules) => ({
                            ...rules,
                            enabled: !rules.enabled,
                          }))
                        }
                        aria-pressed={detectionRules.enabled}
                        aria-label={detectionNotificationToggleLabel}
                        title={`${detectionNotificationToggleLabel} ${detectionOverviewDetail}`}
                      >
                        <span
                          className="settings-detection-auto-knob"
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                    <div
                      className="settings-start-route-strip"
                      role="status"
                      aria-label={recordingStartRoutesLabel}
                      title={recordingStartRoutesLabel}
                    >
                      {recordingStartRoutes.map((route) => (
                        <span
                          key={`${route.label}-${route.value}`}
                          className={`settings-start-route-chip settings-start-route-chip-${route.tone}`}
                        >
                          <span>{route.label}</span>
                          <strong>{route.value}</strong>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="settings-readonly-card settings-detection-card">
                    <div className="settings-detection-card-head">
                      <div
                        className="settings-detection-icon-box settings-detection-icon-box-small"
                        aria-hidden="true"
                      >
                        <Type size={14} strokeWidth={2} />
                      </div>
                      <h3 className="settings-readonly-card-title">
                        検出ルール
                      </h3>
                    </div>
                    <div
                      className="settings-detection-rule-tabs"
                      aria-label={detectionRuleGroupLabel}
                      title={detectionRuleGroupLabel}
                    >
                      {DETECTION_SIGNAL_COUNT_OPTIONS.map((count) => (
                        <button
                          key={count}
                          type="button"
                          className={
                            detectionRules.minimumSignalCount === count
                              ? "settings-detection-tab settings-detection-tab-active"
                              : "settings-detection-tab"
                          }
                          onClick={() =>
                            updateDetectionRules((rules) => ({
                              ...rules,
                              minimumSignalCount: count,
                            }))
                          }
                          aria-pressed={
                            detectionRules.minimumSignalCount === count
                          }
                        >
                          {count}シグナル
                        </button>
                      ))}
                      <button
                        type="button"
                        className={
                          detectionRules.requireAudioSignal
                            ? "settings-detection-tab settings-detection-tab-active"
                            : "settings-detection-tab"
                        }
                        onClick={() =>
                          updateDetectionRules((rules) => ({
                            ...rules,
                            requireAudioSignal: !rules.requireAudioSignal,
                          }))
                        }
                        aria-pressed={detectionRules.requireAudioSignal}
                      >
                        音声必須
                      </button>
                    </div>
                    <div className="settings-detection-rule-list">
                      {DETECTION_SERVICE_OPTIONS.filter((service) =>
                        enabledDetectionServices.has(service.key),
                      ).map((service) => (
                        <div
                          key={service.key}
                          className="settings-detection-rule-item settings-detection-rule-item-active"
                        >
                          <span
                            className="settings-detection-rule-item-icon"
                            aria-hidden="true"
                          >
                            <Search size={12} strokeWidth={2} />
                          </span>
                          <span className="settings-detection-rule-item-text">
                            {service.rule}
                          </span>
                          <button
                            type="button"
                            className="settings-detection-rule-item-remove"
                            onClick={() => toggleDetectionService(service.key)}
                            aria-label={`${service.label}を検出対象から外す`}
                            title={`${service.label}を検出対象から外す`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <div className="settings-detection-rule-item">
                        <span
                          className="settings-detection-rule-item-icon"
                          aria-hidden="true"
                        >
                          <Mic size={12} strokeWidth={2} />
                        </span>
                        <span className="settings-detection-rule-item-text">
                          {detectionRules.requireAudioSignal
                            ? "継続音声を必須シグナルにする"
                            : "継続音声は補助シグナルとして扱う"}
                        </span>
                        <span
                          className="settings-detection-rule-item-remove"
                          aria-hidden="true"
                        >
                          {detectionRules.requireAudioSignal ? "必須" : "任意"}
                        </span>
                      </div>
                    </div>
                    <div
                      className="settings-detection-rule-preview"
                      aria-label={detectionRulePreviewLabel}
                      title={detectionRulePreviewLabel}
                    >
                      <div className="settings-detection-rule-preview-head">
                        <span>通知に進む条件</span>
                        <strong>{detectionSignalRequirementLabel}</strong>
                      </div>
	                      <div className="settings-detection-rule-preview-steps">
	                        <span>URLまたはアプリ</span>
	                        <span>アクティブウィンドウ</span>
	                        <span>
	                          {detectionRules.requireAudioSignal
	                            ? "継続音声必須"
	                            : "継続音声任意"}
	                        </span>
	                      </div>
	                      <div
	                        className="settings-detection-signal-flow"
	                        role="status"
	                        aria-label={detectionSignalFlowLabel}
	                        title={detectionSignalFlowLabel}
	                      >
	                        {detectionSignalFlow.map((item) => (
	                          <span
	                            key={`${item.label}-${item.value}`}
	                            className={`settings-detection-signal-chip settings-detection-signal-chip-${item.tone}`}
	                          >
	                            <span>{item.label}</span>
	                            <strong>{item.value}</strong>
	                          </span>
	                        ))}
	                      </div>
	                    </div>
                    <p
                      className={
                        detectionRules.requireAudioSignal ||
                        detectionRules.minimumSignalCount >= 3
                          ? "settings-detection-runtime-note settings-detection-runtime-note-warning"
                          : "settings-detection-runtime-note"
                      }
                      role={
                        detectionRules.requireAudioSignal ||
                        detectionRules.minimumSignalCount >= 3
                          ? "alert"
                          : "note"
                      }
                    >
                      {detectionSignalRuntimeNote}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === "aiMinutes" && (
              <div className="settings-readonly-grid settings-readonly-grid-ai-minutes">
                <div className="settings-readonly-column">
                  <div
                    className="settings-readonly-card settings-ai-provider-card"
                    aria-label={aiMinutesProviderCardLabel}
                    title={aiMinutesProviderCardLabel}
                  >
                    <div className="settings-detection-head">
                      <div
                        className="settings-detection-icon-box"
                        aria-hidden="true"
                      >
                        <Sparkles size={15} strokeWidth={2.2} />
                      </div>
                      <div className="settings-detection-title-wrap">
                        <h3 className="settings-readonly-card-title">
                          AIプロバイダー
                        </h3>
                        <p className="settings-detection-subtitle">
                          録音後に文字起こしと手書きメモから議事録を作ります。
                        </p>
                      </div>
                      <span
                        className={
                          aiMinutesProvider === "none"
                            ? "settings-detection-auto-switch settings-detection-auto-switch-off"
                            : "settings-detection-auto-switch"
                        }
                        role="status"
                        aria-label={`AIプロバイダー: ${aiMinutesProviderValue}`}
                        title={`AIプロバイダー: ${aiMinutesProviderValue}`}
                      >
                        <span
                          className="settings-detection-auto-knob"
                          aria-hidden="true"
                        />
                      </span>
                    </div>
                    <div
                      className="settings-ai-provider-list"
                      role="radiogroup"
                      aria-label="AI議事録プロバイダー選択。選択だけでは送信せず、文字起こしと手書きメモは手動コピー時に確認します。"
                    >
                      {AI_MINUTES_PROVIDER_OPTIONS.map((provider) => {
                        const isSelected = provider.key === aiMinutesProvider;
                        const badgeClassName =
                          provider.transmission === "none"
                            ? "settings-ai-provider-badge settings-ai-provider-badge-safe"
                            : provider.transmission === "local"
                              ? "settings-ai-provider-badge settings-ai-provider-badge-local"
                              : isSelected
                                ? "settings-ai-provider-badge settings-ai-provider-badge-selected"
                                : "settings-ai-provider-badge";
                        return (
                          <button
                            key={provider.key}
                            type="button"
                            className={
                              isSelected
                                ? "settings-ai-provider-item settings-ai-provider-item-selected"
                                : "settings-ai-provider-item"
                            }
                            role="radio"
                            aria-checked={isSelected}
                            aria-label={`${provider.title}: ${provider.badge}`}
                            title={`${provider.title}: ${provider.description}`}
                            onClick={() =>
                              setLocalSettings((current) =>
                                current
                                  ? {
                                      ...current,
                                      aiMinutesProvider: provider.key,
                                    }
                                  : current,
                              )
                            }
                          >
                            <span className="settings-ai-provider-item-line">
                              <span
                                className="settings-ai-provider-dot"
                                aria-hidden="true"
                              />
                              <span className="settings-ai-provider-title">
                                {provider.title}
                              </span>
                              <span className={badgeClassName}>
                                {isSelected ? "選択中" : provider.badge}
                              </span>
                            </span>
                            <span className="settings-ai-provider-description">
                              {provider.description}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div
                      className="settings-ai-material-flow"
                      role="status"
                      aria-label={aiMinutesMaterialFlowLabel}
                      title={aiMinutesMaterialFlowLabel}
                    >
                      {aiMinutesMaterialSteps.map((step) => (
                        <span
                          key={`${step.label}-${step.value}`}
                          className={`settings-ai-material-step settings-ai-material-step-${step.tone}`}
                        >
                          <span>{step.label}</span>
                          <strong>{step.value}</strong>
                        </span>
                      ))}
                    </div>
                    <div
                      className="settings-ai-provider-disclosure"
                      role="note"
                      aria-label="AI議事録の送信範囲。プロバイダー選択だけでは送信しません。音声トラックは送信せず、文字起こしと手書きメモを手動コピー時に確認します。"
                      title="AI議事録の送信範囲。プロバイダー選択だけでは送信しません。音声トラックは送信せず、文字起こしと手書きメモを手動コピー時に確認します。"
                    >
                      <ShieldCheck size={13} strokeWidth={2.2} aria-hidden="true" />
                      <span>
                        選択だけでは送信しません。音声トラックは送らず、文字起こしと手書きメモを手動コピー時に確認します。
                      </span>
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
                  disabled={updateMutation.isPending}
                  aria-label={saveSettingsLabel}
                  title={saveSettingsLabel}
                >
                  {updateMutation.isPending ? "設定保存中…" : "設定を保存"}
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
    return renderBadge("", STATUS_CHECKING_WITH_DOTS_LABEL, true);
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
    return renderBadge("", STATUS_CHECKING_WITH_DOTS_LABEL, true);
  }
  if (status === "granted") {
    return renderBadge("permission-granted", "許可済み");
  }
  if (status === "denied") {
    return renderBadge("permission-denied", STATUS_DENIED_LABEL);
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
  const isBrowserPreview = !isTauriRuntime();
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
    queryKey: [...queryKey, isBrowserPreview ? "browser-preview" : "tauri"],
    queryFn: () =>
      isBrowserPreview ? Promise.resolve(false) : invoke<boolean>(hasCommand),
  });

  const setMutation = useMutation({
    mutationFn: (apiKey: string) =>
      isBrowserPreview
        ? Promise.resolve(apiKey)
        : invoke(setCommand, { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setKeyInput("");
      showToast(`${providerName} API キーを保存しました`);
    },
    onError: (e) => {
      console.error(
        `${providerName} API キーの保存に失敗しました:`,
        toErrorMessage(e),
      );
      showToast(`${providerName} API キーを保存できませんでした`);
    },
    onSettled: () => {
      isSettingApiKeyRef.current = false;
    },
  });

  const clearMutation = useMutation({
    mutationFn: () =>
      isBrowserPreview ? Promise.resolve() : invoke(clearCommand),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setKeyInput("");
      showToast(`${providerName} API キーを削除しました`);
    },
    onError: (e) => {
      console.error(
        `${providerName} API キーの削除に失敗しました:`,
        toErrorMessage(e),
      );
      showToast(`${providerName} API キーを削除できませんでした`);
    },
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
  const shouldShowSaveApiKeyAction =
    keyInput.trim().length > 0 || setMutation.isPending;
  const shouldShowClearApiKeyAction =
    Boolean(hasKey) || clearMutation.isPending;
  const shouldShowApiKeyActions =
    shouldShowSaveApiKeyAction || shouldShowClearApiKeyAction;
  const shouldShowApiKeyStatus =
    Boolean(hasKeyError) || isFetchingHasKey || hasKey === undefined || hasKey;

  const saveApiKeyLabel = setMutation.isPending
    ? `${providerName} API キーを保存中`
    : `${providerName} API キーを保存`;
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
            : `${providerName} API キーを削除`;
  const apiKeyStatusText = isFetchingHasKey
    ? STATUS_CHECKING_LABEL
    : hasKeyError
      ? STATUS_UNCHECKABLE_LABEL
      : hasKey === undefined
        ? STATUS_CHECKING_LABEL
        : hasKey
          ? "登録済み"
          : STATUS_UNREGISTERED_LABEL;
  const apiKeyStatusClassName = hasKeyError
    ? "settings-api-key-status settings-api-key-status-error"
    : isFetchingHasKey || hasKey === undefined
      ? "settings-api-key-status"
      : hasKey
        ? "settings-api-key-status settings-api-key-status-ready"
        : "settings-api-key-status";
  const apiKeyStatusLabel = hasKey
    ? `${providerName} API キー: 登録済み`
    : `${providerName} API キー: ${apiKeyStatusText}`;
  const refetchApiKeyStatusLabel = isFetchingHasKey
    ? `${providerName} API キーの状態を確認中`
    : `${providerName} API キーの状態を再確認`;
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
        キーは安全に保存され、画面へ再表示されません。設定保存だけでは送信しません。Realtime 利用時は音声を外部送信します。
      </p>
      <div className="settings-api-key">
        {hasKeyError && (
          <div
            className="settings-inline-error"
            role="alert"
            aria-label={`${providerName} API キーを確認できませんでした`}
            title={`${providerName} API キーを確認できませんでした`}
          >
            <span>{providerName} API キーを確認できませんでした</span>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={() => refetchHasKey()}
              disabled={isFetchingHasKey}
              aria-label={refetchApiKeyStatusLabel}
              title={refetchApiKeyStatusLabel}
            >
                {isFetchingHasKey
                  ? `${providerName} キー確認中…`
                  : "APIキー状態を再確認"}
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
        {shouldShowApiKeyActions && (
          <div className="settings-api-key-actions">
            {shouldShowSaveApiKeyAction && (
              <button
                type="button"
                className="control-btn control-btn-transcribe"
                disabled={isApiKeyOperationPending}
                onClick={handleSetApiKey}
                aria-label={saveApiKeyLabel}
                title={saveApiKeyLabel}
              >
                {setMutation.isPending
                  ? `${providerName} キー保存中…`
                  : "APIキーを保存"}
              </button>
            )}
            {shouldShowClearApiKeyAction && (
              <button
                type="button"
                className="control-btn control-btn-clear"
                disabled={
                  Boolean(hasKeyError) ||
                  isFetchingHasKey ||
                  setMutation.isPending ||
                  clearMutation.isPending
                }
                onClick={handleClearApiKey}
                aria-label={clearApiKeyLabel}
                title={clearApiKeyLabel}
              >
                {clearMutation.isPending
                  ? `${providerName} キー削除中…`
                  : "APIキーを削除"}
              </button>
            )}
          </div>
        )}
        {shouldShowApiKeyStatus && (
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
        )}
      </div>
    </div>
  );
}
