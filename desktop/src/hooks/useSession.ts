import { invoke } from "@tauri-apps/api/core";

/**
 * セッション制御用の薄い invoke ラッパー群。
 *
 * useQuery ではなく素の関数として export しているのは、これらが
 * ミーティング開始/終了という副作用の伴う one-shot 操作で、
 * キャッシュ対象になる読み取り API ではないため。
 */

export async function startSession(title: string): Promise<void> {
  // Tauri の InvokeArgs は index signature を要求するため、型注釈は付けず
  // オブジェクトリテラルを直接渡す。
  await invoke<void>("start_session", { title });
}

export async function finalizeAndSaveSession(): Promise<string> {
  // Rust 側は Result<PathBuf, String> を返すが、serde 既定で PathBuf は
  // 文字列化されるためフロントでは string として受け取れる。
  return await invoke<string>("finalize_and_save_session");
}
