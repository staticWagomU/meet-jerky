import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

export function usePermissions() {
  const {
    data: micPermission,
    error: micPermissionError,
    isFetching: isFetchingMicPermission,
    refetch: refetchMic,
  } = useQuery<string, unknown>({
    queryKey: ["microphonePermission"],
    queryFn: () => invoke<string>("check_microphone_permission"),
  });

  const {
    data: screenPermission,
    error: screenPermissionError,
    isFetching: isFetchingScreenPermission,
    refetch: refetchScreen,
  } = useQuery<string, unknown>({
    queryKey: ["screenRecordingPermission"],
    queryFn: () => invoke<string>("check_screen_recording_permission"),
  });

  const refetchAll = () => {
    refetchMic();
    refetchScreen();
  };
  const isCheckingPermissions =
    isFetchingMicPermission || isFetchingScreenPermission;

  return {
    micPermission,
    micPermissionError,
    screenPermission,
    screenPermissionError,
    isCheckingPermissions,
    refetchAll,
  };
}
