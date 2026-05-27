//! Mock 2C - Recording Detail から呼ばれるセッション本文読み込みコマンド。
//!
//! Mock 2C は文字起こし全文・AI議事録の入口を 1 画面に集約するため、
//! `list_session_summaries_cmd` の searchText（先頭 64KiB のみ）ではなく
//! ファイルの本文をそのまま要求する。
//!
//! 設計上の前提:
//! - frontend は list で得た path をそのまま渡す。任意パスは受け付けない。
//! - `resolve_output_directory` 配下に居ることを canonical path で検証する。
//! - 拡張子は `.md` のみ許可する。Markdown 以外を要求された場合は早期失敗。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::session_commands_helpers::resolve_output_directory;
use crate::settings::SettingsStateHandle;

/// 4 MiB 上限。文字起こし最長の現実的範囲を踏まえ、暴走時の OOM を防ぐ。
const MAX_SESSION_CONTENT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContent {
    pub path: PathBuf,
    pub body: String,
}

/// テスト可能な実装本体。
///
/// `output_dir` 内に解決される .md ファイルだけを読み出す。
pub fn read_session_content_inner(
    output_dir: &Path,
    requested: &Path,
) -> Result<SessionContent, String> {
    let canonical_dir = output_dir
        .canonicalize()
        .map_err(|e| format!("セッション保存先の確認に失敗しました: {e}"))?;
    let canonical_target = requested
        .canonicalize()
        .map_err(|e| format!("セッションファイルの確認に失敗しました: {e}"))?;

    if !canonical_target.starts_with(&canonical_dir) {
        return Err("セッションファイルが保存先ディレクトリの外を指しています".into());
    }
    if canonical_target.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("セッションファイルは .md でなければなりません".into());
    }

    let metadata = fs::metadata(&canonical_target)
        .map_err(|e| format!("セッションファイルのメタデータ取得に失敗しました: {e}"))?;
    if metadata.len() > MAX_SESSION_CONTENT_BYTES {
        return Err(format!(
            "セッションファイルが大きすぎて読み込めません ({} bytes > {} bytes)",
            metadata.len(),
            MAX_SESSION_CONTENT_BYTES
        ));
    }

    let body = fs::read_to_string(&canonical_target)
        .map_err(|e| format!("セッション本文の読み込みに失敗しました: {e}"))?;
    Ok(SessionContent {
        path: canonical_target,
        body,
    })
}

#[tauri::command]
pub fn read_session_content_cmd(
    path: String,
    settings_state: tauri::State<'_, SettingsStateHandle>,
) -> Result<SessionContent, String> {
    let output_dir = resolve_output_directory(settings_state.inner());
    read_session_content_inner(&output_dir, Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_markdown_body_when_path_is_inside_output_dir() {
        let dir = tempdir().unwrap();
        let session_path = dir.path().join("100-0.md");
        let body = "# 会議メモ - 2024-04-17 14:50\n\n**[14:50:15] 自分:** こんにちは\n";
        fs::write(&session_path, body).unwrap();

        let content = read_session_content_inner(dir.path(), &session_path)
            .expect("read should succeed for in-dir markdown");

        assert_eq!(content.body, body);
        assert_eq!(
            content.path.canonicalize().unwrap(),
            session_path.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_path_outside_output_dir() {
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("100-0.md");
        fs::write(&outside_file, "# 外部ファイル").unwrap();

        let output_dir = tempdir().unwrap();
        let err = read_session_content_inner(output_dir.path(), &outside_file)
            .expect_err("path outside output_dir should be rejected");

        assert!(
            err.contains("外を指しています"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn rejects_non_md_extension() {
        let dir = tempdir().unwrap();
        let not_md = dir.path().join("100-0.txt");
        fs::write(&not_md, "not markdown").unwrap();

        let err = read_session_content_inner(dir.path(), &not_md)
            .expect_err("non .md extension should be rejected");

        assert!(err.contains(".md"), "unexpected error message: {err}");
    }

    #[test]
    fn returns_error_when_file_does_not_exist() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("404-0.md");

        let err = read_session_content_inner(dir.path(), &missing)
            .expect_err("missing file should error");

        assert!(
            err.contains("セッションファイルの確認に失敗しました"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn rejects_file_larger_than_limit() {
        let dir = tempdir().unwrap();
        let huge = dir.path().join("100-0.md");
        let body = "x".repeat(MAX_SESSION_CONTENT_BYTES as usize + 1);
        fs::write(&huge, body).unwrap();

        let err = read_session_content_inner(dir.path(), &huge)
            .expect_err("oversized file should be rejected");

        assert!(
            err.contains("大きすぎて"),
            "unexpected error message: {err}"
        );
    }
}
