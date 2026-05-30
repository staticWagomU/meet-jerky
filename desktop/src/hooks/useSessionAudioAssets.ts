import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { isTauriRuntime } from "../utils/browserRuntime";

export interface SessionAudioAsset {
  track: "microphone" | "speaker" | "mix";
  path: string;
  exists: boolean;
}

export interface SessionAudioAssets {
  sessionPath: string;
  microphone: SessionAudioAsset;
  speaker: SessionAudioAsset;
  mix: SessionAudioAsset;
}

function getPreviewAudioAssets(path: string): SessionAudioAssets {
  const basePath = path.replace(/\.md$/i, "");
  return {
    sessionPath: path,
    microphone: {
      track: "microphone",
      path: `${basePath}.mic.wav`,
      exists: false,
    },
    speaker: {
      track: "speaker",
      path: `${basePath}.speaker.wav`,
      exists: false,
    },
    mix: {
      track: "mix",
      path: `${basePath}.mix.wav`,
      exists: false,
    },
  };
}

export function useSessionAudioAssets(path: string | null) {
  const shouldUsePreviewData = !isTauriRuntime();
  return useQuery<SessionAudioAssets>({
    queryKey: [
      "sessionAudioAssets",
      path,
      shouldUsePreviewData ? "browser-preview" : "tauri",
    ],
    enabled: typeof path === "string" && path.length > 0,
    queryFn: () =>
      shouldUsePreviewData
        ? Promise.resolve(getPreviewAudioAssets(path ?? ""))
        : invoke<SessionAudioAssets>("get_session_audio_assets_cmd", { path }),
  });
}
