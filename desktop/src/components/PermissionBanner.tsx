import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

export function PermissionBanner() {
  const { data: micPermission, refetch: refetchMic } = useQuery<string>({
    queryKey: ["microphonePermission"],
    queryFn: () => invoke<string>("check_microphone_permission"),
  });

  const { data: screenPermission, refetch: refetchScreen } = useQuery<string>({
    queryKey: ["screenRecordingPermission"],
    queryFn: () => invoke<string>("check_screen_recording_permission"),
  });

  const handleRecheck = useCallback(() => {
    refetchMic();
    refetchScreen();
  }, [refetchMic, refetchScreen]);

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
        onClick={handleRecheck}
      >
        再チェック
      </button>
    </div>
  );
}
