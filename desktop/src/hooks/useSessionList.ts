import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

/// バックエンドが camelCase でシリアライズする SessionSummary の型定義。
/// 参照: desktop/src-tauri/src/session_store.rs
export interface SessionSummary {
  path: string;
  startedAtSecs: number;
  title: string;
}

/**
 * 保存済みセッション一覧を取得するフック。
 * `list_session_summaries_cmd` は存在しない出力ディレクトリに対しても空配列を返すため、
 * 初回起動時でもエラーにならない。
 */
export function useSessionList() {
  const query = useQuery<SessionSummary[]>({
    queryKey: ["sessionList"],
    queryFn: () => invoke<SessionSummary[]>("list_session_summaries_cmd"),
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
