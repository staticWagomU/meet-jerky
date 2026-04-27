import { usePermissions } from "../hooks/usePermissions";
import { toErrorMessage } from "../utils/errorMessage";

export function PermissionBanner() {
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
  const permissionBannerRole =
    hasCheckError || hasDeniedPermission ? "alert" : "status";
  const permissionBannerClassName =
    hasCheckError || hasDeniedPermission
      ? "permission-banner permission-banner-warning permission-banner-alert"
      : "permission-banner permission-banner-warning";
  const micPermissionErrorMessage = micPermissionError
    ? toErrorMessage(micPermissionError)
    : null;
  const screenPermissionErrorMessage = screenPermissionError
    ? toErrorMessage(screenPermissionError)
    : null;
  const micStatusLabel = isCheckingPermissions
    ? "確認中"
    : micPermissionError
      ? "確認失敗"
      : micPermission === "denied"
        ? "未許可"
        : "未確認";
  const screenStatusLabel = isCheckingPermissions
    ? "確認中"
    : screenPermissionError
      ? "確認失敗"
      : screenPermission === "denied"
        ? "未許可"
        : "未確認";
  const micPermissionDetail = [
    "自分トラック マイク",
    micStatusLabel,
    micPermissionErrorMessage,
  ]
    .filter(Boolean)
    .join(": ");
  const screenPermissionDetail = [
    "相手側トラック 画面収録",
    screenStatusLabel,
    screenPermissionErrorMessage,
  ]
    .filter(Boolean)
    .join(": ");
  const permissionSummaryLabel = [
    "録音と取得の権限状態",
    micNeedsAttention ? micPermissionDetail : null,
    screenNeedsAttention ? screenPermissionDetail : null,
  ]
    .filter(Boolean)
    .join("、");
  const permissionRetryLabel = isCheckingPermissions
    ? "macOS 権限状態を確認中"
    : "macOS 権限状態を再チェック";

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
      <div className="permission-banner-title">
        {isCheckingPermissions
          ? "権限状態を確認中です"
          : hasCheckError
            ? "権限状態を確認できません"
            : "権限の確認が必要です"}
      </div>
      <div className="permission-banner-summary">
        {micNeedsAttention && (
          <span
            className="permission-summary-pill"
            aria-label={micPermissionDetail}
            title={micPermissionDetail}
          >
            マイク / 自分: {micStatusLabel}
          </span>
        )}
        {screenNeedsAttention && (
          <span
            className="permission-summary-pill"
            aria-label={screenPermissionDetail}
            title={screenPermissionDetail}
          >
            画面収録 / 相手側: {screenStatusLabel}
          </span>
        )}
      </div>
      <div className="permission-banner-body">
        {micNeedsAttention && (
          <p>
            {isCheckingPermissions
              ? "マイク権限の状態を確認しています。"
              : micPermissionError
              ? "マイク権限の状態を macOS から取得できませんでした。自分トラックの録音・文字起こし可否が不明です。"
              : "マイクが未許可です。自分トラックは録音・文字起こしされません。"}
            <br />
            <strong>システム設定 &gt; プライバシーとセキュリティ &gt; マイク</strong>
            で状態を確認してください。
          </p>
        )}
        {screenNeedsAttention && (
          <p>
            {isCheckingPermissions
              ? "画面収録権限の状態を確認しています。"
              : screenPermissionError
              ? "画面収録権限の状態を macOS から取得できませんでした。相手側音声の取得・文字起こし可否が不明です。"
              : "画面収録が未許可です。相手側音声は取得・文字起こしされません。"}
            <br />
            <strong>
              システム設定 &gt; プライバシーとセキュリティ &gt; 画面収録
            </strong>
            で状態を確認してください。
          </p>
        )}
      </div>
      <button
        type="button"
        className="control-btn control-btn-clear"
        onClick={refetchAll}
        disabled={isCheckingPermissions}
        aria-label={permissionRetryLabel}
        title={permissionRetryLabel}
      >
        {isCheckingPermissions ? "確認中..." : "再チェック"}
      </button>
    </div>
  );
}
