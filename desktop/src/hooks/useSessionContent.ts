import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { isTauriRuntime } from "../utils/browserRuntime";
import { getPreviewSessionContent } from "../utils/previewSessionData";

/// バックエンドが camelCase でシリアライズする SessionContent。
/// 参照: desktop/src-tauri/src/session_commands_read.rs
export interface SessionContent {
  path: string;
  body: string;
}

export function useSessionContent(path: string | null) {
  const shouldUsePreviewData = !isTauriRuntime();
  return useQuery<SessionContent>({
    queryKey: [
      "sessionContent",
      path,
      shouldUsePreviewData ? "browser-preview" : "tauri",
    ],
    enabled: typeof path === "string" && path.length > 0,
    queryFn: async () => {
      if (!shouldUsePreviewData) {
        return invoke<SessionContent>("read_session_content_cmd", { path });
      }
      const previewContent = getPreviewSessionContent(path ?? "");
      if (!previewContent) {
        throw new Error("ブラウザプレビュー用の文字起こしがありません。");
      }
      return previewContent;
    },
  });
}
