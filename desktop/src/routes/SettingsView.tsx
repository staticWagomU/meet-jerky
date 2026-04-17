import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppSettings, AudioDevice, TranscriptionEngineType } from "../types";

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

  const { data: settings, isLoading: isLoadingSettings } = useQuery<AppSettings>({
    queryKey: ["settings"],
    queryFn: () => invoke<AppSettings>("get_settings"),
  });

  const { data: devices } = useQuery<AudioDevice[]>({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<AudioDevice[]>("list_audio_devices"),
  });

  const { data: defaultOutputDir } = useQuery<string>({
    queryKey: ["defaultOutputDirectory"],
    queryFn: () => invoke<string>("get_default_output_directory"),
  });

  const { data: micPermission, refetch: refetchMicPermission } = useQuery<string>({
    queryKey: ["microphonePermission"],
    queryFn: () => invoke<string>("check_microphone_permission"),
  });

  const { data: screenPermission, refetch: refetchScreenPermission } = useQuery<string>({
    queryKey: ["screenRecordingPermission"],
    queryFn: () => invoke<string>("check_screen_recording_permission"),
  });

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
  });

  useEffect(() => {
    if (settings && !localSettings) {
      setLocalSettings(settings);
    }
  }, [settings, localSettings]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  const handleSave = useCallback(() => {
    if (localSettings) {
      updateMutation.mutate(localSettings);
    }
  }, [localSettings, updateMutation]);

  const handleSelectOutputDirectory = useCallback(async () => {
    try {
      const selected = await invoke<string | null>("select_output_directory");
      if (selected && localSettings) {
        setLocalSettings({ ...localSettings, outputDirectory: selected });
      }
    } catch (e) {
      console.error("フォルダ選択に失敗しました:", e);
    }
  }, [localSettings]);

  const handleResetOutputDirectory = useCallback(() => {
    if (localSettings) {
      setLocalSettings({ ...localSettings, outputDirectory: null });
    }
  }, [localSettings]);

  const handleRecheckPermissions = useCallback(() => {
    refetchMicPermission();
    refetchScreenPermission();
  }, [refetchMicPermission, refetchScreenPermission]);

  if (isLoadingSettings || !localSettings) {
    return <div className="settings-view">読み込み中...</div>;
  }

  const hasChanges = JSON.stringify(localSettings) !== JSON.stringify(settings);

  return (
    <div className="settings-view">
      {/* 文字起こしエンジン */}
      <div className="settings-section">
        <h3 className="settings-section-title">文字起こしエンジン</h3>
        <div className="settings-radio-group">
          <label className="settings-radio-label">
            <input
              type="radio"
              name="engine"
              value="local"
              checked={localSettings.transcriptionEngine === "local"}
              onChange={() =>
                setLocalSettings({
                  ...localSettings,
                  transcriptionEngine: "local" as TranscriptionEngineType,
                })
              }
            />
            <span>ローカル (Whisper)</span>
          </label>
          <label className="settings-radio-label settings-radio-disabled">
            <input
              type="radio"
              name="engine"
              value="cloud"
              disabled
            />
            <span>クラウド</span>
            <span className="settings-note">Phase 6で対応</span>
          </label>
        </div>
      </div>

      {/* Whisperモデル */}
      <div className="settings-section">
        <h3 className="settings-section-title">Whisperモデル</h3>
        <select
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

      {/* マイクデバイス */}
      <div className="settings-section">
        <h3 className="settings-section-title">マイクデバイス</h3>
        <select
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
      </div>

      {/* 言語 */}
      <div className="settings-section">
        <h3 className="settings-section-title">言語</h3>
        <select
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
          <span className="settings-output-path">
            {localSettings.outputDirectory ?? defaultOutputDir ?? "未設定"}
          </span>
          <div className="settings-output-actions">
            <button
              type="button"
              className="control-btn control-btn-transcribe"
              onClick={handleSelectOutputDirectory}
            >
              フォルダ選択
            </button>
            <button
              type="button"
              className="control-btn control-btn-clear"
              onClick={handleResetOutputDirectory}
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
            <span className="settings-permission-label">マイク:</span>
            <PermissionBadge status={micPermission} />
          </div>
          <div className="settings-permission-row">
            <span className="settings-permission-label">画面収録:</span>
            <PermissionBadge status={screenPermission} />
          </div>
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={handleRecheckPermissions}
          >
            再チェック
          </button>
        </div>
      </div>

      {/* 保存ボタン */}
      <div className="settings-actions">
        <button
          type="button"
          className="control-btn control-btn-transcribe settings-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || updateMutation.isPending}
        >
          {updateMutation.isPending ? "保存中..." : "設定を保存"}
        </button>
      </div>

      {/* トースト通知 */}
      {toastMessage && (
        <div className="toast">{toastMessage}</div>
      )}
    </div>
  );
}

function PermissionBadge({ status }: { status: string | undefined }) {
  if (!status) return <span className="settings-permission-badge">確認中...</span>;
  if (status === "granted") {
    return <span className="settings-permission-badge permission-granted">許可済み</span>;
  }
  if (status === "denied") {
    return <span className="settings-permission-badge permission-denied">拒否</span>;
  }
  return <span className="settings-permission-badge permission-undetermined">未確認</span>;
}
