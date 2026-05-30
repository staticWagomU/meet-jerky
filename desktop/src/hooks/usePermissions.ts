import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { isTauriRuntime } from "../utils/browserRuntime";

export function usePermissions() {
  const shouldUsePreviewData = !isTauriRuntime();
  const {
    data: micPermission,
    error: micPermissionError,
    isFetching: isFetchingMicPermission,
    refetch: refetchMic,
  } = useQuery<string, unknown>({
    queryKey: [
      "microphonePermission",
      shouldUsePreviewData ? "browser-preview" : "tauri",
    ],
    queryFn: () =>
      shouldUsePreviewData
        ? Promise.resolve("granted")
        : invoke<string>("check_microphone_permission"),
  });

  const {
    data: screenPermission,
    error: screenPermissionError,
    isFetching: isFetchingScreenPermission,
    refetch: refetchScreen,
  } = useQuery<string, unknown>({
    queryKey: [
      "screenRecordingPermission",
      shouldUsePreviewData ? "browser-preview" : "tauri",
    ],
    queryFn: () =>
      shouldUsePreviewData
        ? Promise.resolve("granted")
        : invoke<string>("check_screen_recording_permission"),
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
    isFetchingMicPermission,
    screenPermission,
    screenPermissionError,
    isFetchingScreenPermission,
    isCheckingPermissions,
    refetchAll,
  };
}
