import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

export function usePermissions() {
  const { data: micPermission, refetch: refetchMic } = useQuery<string>({
    queryKey: ["microphonePermission"],
    queryFn: () => invoke<string>("check_microphone_permission"),
  });

  const { data: screenPermission, refetch: refetchScreen } = useQuery<string>({
    queryKey: ["screenRecordingPermission"],
    queryFn: () => invoke<string>("check_screen_recording_permission"),
  });

  const refetchAll = () => {
    refetchMic();
    refetchScreen();
  };

  return { micPermission, screenPermission, refetchAll };
}
