import { usePermissions } from "../hooks/usePermissions";

export function PermissionBanner() {
  const {
    micPermission,
    micPermissionError,
    screenPermission,
    screenPermissionError,
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

  return (
    <div className="permission-banner permission-banner-warning">
      <div className="permission-banner-title">
        {hasCheckError ? "権限状態を確認できません" : "権限の確認が必要です"}
      </div>
      <div className="permission-banner-body">
        {micNeedsAttention && (
          <p>
            {micPermissionError
              ? "マイク権限の状態をmacOSから取得できませんでした。録音の可否が不明です。"
              : "マイクへのアクセスが許可されていません。"}
            <br />
            <strong>システム設定 &gt; プライバシーとセキュリティ &gt; マイク</strong>
            で状態を確認してください。
          </p>
        )}
        {screenNeedsAttention && (
          <p>
            {screenPermissionError
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
      >
        再チェック
      </button>
    </div>
  );
}
