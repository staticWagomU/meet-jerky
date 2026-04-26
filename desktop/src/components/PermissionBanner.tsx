import { usePermissions } from "../hooks/usePermissions";

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

  return (
    <div className="permission-banner permission-banner-warning" role="alert">
      <div className="permission-banner-title">
        {isCheckingPermissions
          ? "権限状態を確認中です"
          : hasCheckError
            ? "権限状態を確認できません"
            : "権限の確認が必要です"}
      </div>
      <div className="permission-banner-summary">
        {micNeedsAttention && (
          <span className="permission-summary-pill">
            マイク / 自分: {micStatusLabel}
          </span>
        )}
        {screenNeedsAttention && (
          <span className="permission-summary-pill">
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
              ? "マイク権限の状態をmacOSから取得できませんでした。録音の可否が不明です。"
              : "マイクへのアクセスが許可されていません。"}
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
              ? "画面収録権限の状態をmacOSから取得できませんでした。相手側の音声取得可否が不明です。"
              : "画面収録のアクセスが許可されていません。"}
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
      >
        {isCheckingPermissions ? "確認中..." : "再チェック"}
      </button>
    </div>
  );
}
