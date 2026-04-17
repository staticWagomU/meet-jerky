import { usePermissions } from "../hooks/usePermissions";

export function PermissionBanner() {
  const { micPermission, screenPermission, refetchAll } = usePermissions();

  const micNeedsAttention =
    micPermission === "denied" || micPermission === "undetermined";
  const screenNeedsAttention =
    screenPermission === "denied" || screenPermission === "undetermined";

  if (!micNeedsAttention && !screenNeedsAttention) {
    return null;
  }

  return (
    <div className="permission-banner permission-banner-warning">
      <div className="permission-banner-title">権限の確認が必要です</div>
      <div className="permission-banner-body">
        {micNeedsAttention && (
          <p>
            マイクへのアクセスが許可されていません。
            <br />
            <strong>システム設定 &gt; プライバシーとセキュリティ &gt; マイク</strong>
            で許可してください。
          </p>
        )}
        {screenNeedsAttention && (
          <p>
            画面収録のアクセスが許可されていません。
            <br />
            <strong>
              システム設定 &gt; プライバシーとセキュリティ &gt; 画面収録
            </strong>
            で許可してください。
          </p>
        )}
      </div>
      <button
        type="button"
        className="control-btn control-btn-clear"
        onClick={refetchAll}
      >
        再チェック
      </button>
    </div>
  );
}
