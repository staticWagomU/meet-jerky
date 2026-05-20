import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

/// バックエンドが camelCase でシリアライズする SessionContent。
/// 参照: desktop/src-tauri/src/session_commands_read.rs
export interface SessionContent {
  path: string;
  body: string;
}

export function useSessionContent(path: string | null) {
  return useQuery<SessionContent>({
    queryKey: ["sessionContent", path],
    enabled: typeof path === "string" && path.length > 0,
    queryFn: () => invoke<SessionContent>("read_session_content_cmd", { path }),
  });
}
