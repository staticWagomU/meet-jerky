import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { usePermissions } from "../hooks/usePermissions";
import { toErrorMessage } from "../utils/errorMessage";
import {
  MACOS_MICROPHONE_PRIVACY_URL,
  MACOS_SCREEN_RECORDING_PRIVACY_URL,
  OPEN_MICROPHONE_PRIVACY_LABEL,
  OPEN_SCREEN_RECORDING_PRIVACY_LABEL,
} from "../utils/macosPrivacySettings";
import {
  OTHER_TRACK_PERMISSION_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "../utils/audioTrackLabels";
import {
  STATUS_CHECKING_LABEL,
  STATUS_DENIED_LABEL,
  STATUS_UNCHECKABLE_LABEL,
  STATUS_UNDETERMINED_LABEL,
} from "../utils/statusLabels";

export function PermissionBanner() {
  const [settingsOpenError, setSettingsOpenError] = useState<string | null>(
    null,
  );
  const {
    micPermission,
    micPermissionError,
    screenPermission,
    screenPermissionError,
    isCheckingPermissions,
    refetchAll,
  } = usePermissions();

  const micNeedsAttention =
    Boolean(micPermissionError) ||
    micPermission === "denied" ||
    micPermission === "undetermined";
  const screenNeedsAttention =
    Boolean(screenPermissionError) ||
    screenPermission === "denied" ||
    screenPermission === "undetermined";

  if (!micNeedsAttention && !screenNeedsAttention) {
    return null;
  }

  const hasCheckError =
    Boolean(micPermissionError) || Boolean(screenPermissionError);
  const hasDeniedPermission =
    micPermission === "denied" || screenPermission === "denied";
  const settingsOpenErrorLabel = settingsOpenError
    ? "macOS 設定を開けませんでした"
    : null;
  const settingsOpenErrorTitle = settingsOpenError ?? undefined;
  const hasSettingsOpenError = Boolean(settingsOpenErrorLabel);
  const permissionBannerRole =
    hasCheckError || hasDeniedPermission || hasSettingsOpenError
      ? "alert"
      : "status";
  const permissionBannerClassName =
    hasCheckError || hasDeniedPermission || hasSettingsOpenError
      ? "permission-banner permission-banner-warning permission-banner-alert"
      : "permission-banner permission-banner-warning";
  const micPermissionErrorMessage = micPermissionError
    ? toErrorMessage(micPermissionError)
    : null;
  const screenPermissionErrorMessage = screenPermissionError
    ? toErrorMessage(screenPermissionError)
    : null;
  const micStatusLabel = isCheckingPermissions
    ? STATUS_CHECKING_LABEL
    : micPermissionError
      ? STATUS_UNCHECKABLE_LABEL
      : micPermission === "denied"
        ? STATUS_DENIED_LABEL
        : STATUS_UNDETERMINED_LABEL;
  const screenStatusLabel = isCheckingPermissions
    ? STATUS_CHECKING_LABEL
    : screenPermissionError
      ? STATUS_UNCHECKABLE_LABEL
      : screenPermission === "denied"
        ? STATUS_DENIED_LABEL
        : STATUS_UNDETERMINED_LABEL;
  const micPermissionDetail = [
    SELF_TRACK_DEVICE_LABEL,
    "macOS マイク権限",
    micStatusLabel,
    micPermissionErrorMessage,
  ]
    .filter(Boolean)
    .join(": ");
  const screenPermissionDetail = [
    OTHER_TRACK_PERMISSION_LABEL,
    "macOS 画面収録権限",
    screenStatusLabel,
    screenPermissionErrorMessage,
  ]
    .filter(Boolean)
    .join(": ");
  const permissionSummaryLabel = [
    "録音と取得の権限状態",
    micNeedsAttention ? micPermissionDetail : null,
    screenNeedsAttention ? screenPermissionDetail : null,
    settingsOpenErrorLabel,
  ]
    .filter(Boolean)
    .join("、");
  const permissionRetryLabel = isCheckingPermissions
    ? "権限を確認中"
    : "権限を再確認";
  const micPermissionBody = isCheckingPermissions
    ? "マイクを確認中。"
    : micPermissionError
      ? `${SELF_TRACK_DEVICE_LABEL}を確認できません。`
      : micPermission === "denied"
        ? `${SELF_TRACK_DEVICE_LABEL}は録音されません。`
        : `${SELF_TRACK_DEVICE_LABEL}は許可待ちです。`;
  const screenPermissionBody = isCheckingPermissions
    ? "画面収録を確認中。"
    : screenPermissionError
      ? "相手側トラックを確認できません。"
      : screenPermission === "denied"
        ? "相手側の音声は取得されません。"
        : "相手側トラックは許可待ちです。";
  const permissionAttentionCount =
    Number(micNeedsAttention) + Number(screenNeedsAttention);
  const permissionBannerKicker = isCheckingPermissions
    ? "権限確認中"
    : hasCheckError
      ? "要確認"
      : `${permissionAttentionCount}件ブロック`;
  const permissionResolutionLabel = hasDeniedPermission
    ? "macOS 設定で許可が必要です"
    : hasCheckError
      ? "状態取得に失敗しました"
      : "録音前に確認";
  const permissionImpactItems = [
    {
      label: "録音開始",
      value: hasDeniedPermission ? "制限あり" : "録音前確認",
      detail: "録音開始前に通知",
    },
    {
      label: "トラック",
      value:
        micNeedsAttention && screenNeedsAttention
          ? "両トラック注意"
          : micNeedsAttention
            ? "自分 注意"
            : "相手側 注意",
      detail: `${SELF_TRACK_DEVICE_LABEL} / ${OTHER_TRACK_PERMISSION_LABEL}`,
    },
    {
      label: "REC表示",
      value: "REC 表示",
      detail: "録音中は隠しません",
    },
    {
      label: "AI議事録",
      value: "AI外部送信なし",
      detail: "手動コピー確認",
    },
  ] as const;
  const permissionPreflightFlow = [
    {
      label: "権限",
      value:
        micNeedsAttention && screenNeedsAttention
          ? "2件確認"
          : micNeedsAttention
            ? "マイク確認"
            : "画面収録確認",
      tone: hasDeniedPermission || hasCheckError ? "warn" : "accent",
    },
    {
      label: "開始",
      value: "通知 / メニュー",
      tone: "accent",
    },
    {
      label: "録音中",
      value: "REC常時表示",
      tone: "safe",
    },
    {
      label: "保存",
      value: "このMac",
      tone: "safe",
    },
  ] as const;
  const permissionPreflightFlowLabel = [
    "録音前の確認フロー",
    `権限 ${permissionPreflightFlow[0].value}`,
    "会議検知通知またはメニューバー録音から開始",
    "録音中はRECを常時表示",
    "録音履歴、文字起こし、音声トラックはこのMacに保存",
  ].join("。");

  return (
    <div
      className={permissionBannerClassName}
      role={permissionBannerRole}
      aria-busy={isCheckingPermissions}
      aria-live={permissionBannerRole === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={permissionSummaryLabel}
      title={permissionSummaryLabel}
    >
      <div className="permission-banner-header">
        <div className="permission-banner-heading">
          <span>{permissionBannerKicker}</span>
          <div className="permission-banner-title">
            {isCheckingPermissions
              ? "権限を確認中"
              : hasCheckError
                ? "権限を確認できません"
                : "権限確認が必要"}
          </div>
        </div>
        <span className="permission-banner-resolution">
          {permissionResolutionLabel}
        </span>
      </div>
      <div className="permission-banner-summary">
        {micNeedsAttention && (
          <span
            className="permission-summary-pill"
            aria-label={micPermissionDetail}
            title={micPermissionDetail}
          >
            マイク: {micStatusLabel}
          </span>
        )}
        {screenNeedsAttention && (
          <span
            className="permission-summary-pill"
            aria-label={screenPermissionDetail}
            title={screenPermissionDetail}
          >
            相手側: {screenStatusLabel}
          </span>
        )}
      </div>
      <div
        className="permission-banner-impact-grid"
        aria-label="録音開始への影響"
      >
        {permissionImpactItems.map((item) => (
          <span className="permission-banner-impact-item" key={item.label}>
            <strong>{item.label}</strong>
            <small>{item.value}</small>
            <em>{item.detail}</em>
          </span>
        ))}
      </div>
      <div
        className="permission-banner-preflight-flow"
        role="status"
        aria-label={permissionPreflightFlowLabel}
        title={permissionPreflightFlowLabel}
      >
        {permissionPreflightFlow.map((item) => (
          <span
            key={`${item.label}-${item.value}`}
            className={`permission-banner-preflight-chip permission-banner-preflight-chip-${item.tone}`}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </span>
        ))}
      </div>
      <div className="permission-banner-body">
        {micNeedsAttention && (
          <p>
            {micPermissionBody}
            <br />
            <strong>
              システム設定 &gt; プライバシーとセキュリティ &gt; マイク
            </strong>
            で許可。
          </p>
        )}
        {screenNeedsAttention && (
          <p>
            {screenPermissionBody}
            <br />
            <strong>
              システム設定 &gt; プライバシーとセキュリティ &gt; 画面収録
            </strong>
            で許可。
          </p>
        )}
      </div>
      <div className="permission-banner-actions">
        <button
          type="button"
          className="control-btn control-btn-clear"
          onClick={() => {
            setSettingsOpenError(null);
            refetchAll();
          }}
          disabled={isCheckingPermissions}
          aria-label={permissionRetryLabel}
          title={permissionRetryLabel}
        >
          {isCheckingPermissions ? "権限確認中…" : "権限再確認"}
        </button>
        {micNeedsAttention && (
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => {
              setSettingsOpenError(null);
              void openUrl(MACOS_MICROPHONE_PRIVACY_URL).catch((e) => {
                const msg = toErrorMessage(e);
                console.error("マイク権限設定を開けませんでした:", msg);
                setSettingsOpenError(msg);
              });
            }}
            aria-label={OPEN_MICROPHONE_PRIVACY_LABEL}
            title={OPEN_MICROPHONE_PRIVACY_LABEL}
          >
            マイク設定
          </button>
        )}
        {screenNeedsAttention && (
          <button
            type="button"
            className="control-btn control-btn-clear"
            onClick={() => {
              setSettingsOpenError(null);
              void openUrl(MACOS_SCREEN_RECORDING_PRIVACY_URL).catch((e) => {
                const msg = toErrorMessage(e);
                console.error("画面収録設定を開けませんでした:", msg);
                setSettingsOpenError(msg);
              });
            }}
            aria-label={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
            title={OPEN_SCREEN_RECORDING_PRIVACY_LABEL}
          >
            画面収録設定
          </button>
        )}
      </div>
      {settingsOpenErrorLabel && (
        <p
          className="permission-banner-inline-error"
          role="alert"
          aria-label={settingsOpenErrorLabel}
          title={settingsOpenErrorTitle}
        >
          {settingsOpenErrorLabel}
        </p>
      )}
    </div>
  );
}
