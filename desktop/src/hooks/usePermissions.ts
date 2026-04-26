import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

export function usePermissions() {
  const {
    data: micPermission,
    error: micPermissionError,
    refetch: refetchMic,
  } = useQuery<string, unknown>({
    queryKey: ["microphonePermission"],
    queryFn: () => invoke<string>("check_microphone_permission"),
  });

  const {
    data: screenPermission,
    error: screenPermissionError,
    refetch: refetchScreen,
  } = useQuery<string, unknown>({
    queryKey: ["screenRecordingPermission"],
    queryFn: () => invoke<string>("check_screen_recording_permission"),
  });

  const refetchAll = () => {
    refetchMic();
    refetchScreen();
  };

  return {
    micPermission,
    micPermissionError,
    screenPermission,
    screenPermissionError,
    refetchAll,
  };
}
