//! Tauri コマンドの薄いアダプタ層。
//!
//! 実ロジックは `*_inner` 関数に集約してテスト可能にし、
//! `#[tauri::command]` は State / 現在時刻取得などの周辺をまとめるだけの薄いラッパーにする。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::FixedOffset;

use crate::session_manager::SessionManager;
use crate::session_store;
use crate::session_store_types::SessionSummary;
use crate::settings::{default_output_directory, SettingsStateHandle};

/// 現在時刻 (unix 秒) を取得。`SystemTime::now` の逆行時は 0 を返すが、
/// 実用上ここに来るケースは無い。
fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Phase 5 時点で採用する表示タイムゾーン (JST 固定)。
///
/// 将来ユーザー設定化する際はここを差し替えれば良い。
fn default_offset() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).expect("JST offset is always valid")
}

/// 設定から出力ディレクトリを解決する。未設定 or 空文字の場合は
/// アプリ既定ディレクトリを使う。
fn resolve_output_directory(settings_state: &SettingsStateHandle) -> PathBuf {
    let settings = settings_state.0.lock();
    match settings.output_directory.as_deref() {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => default_output_directory(),
    }
}

// ─────────────────────────────────────────────
// start_session
// ─────────────────────────────────────────────

/// テスト可能な start_session 実装本体。
///
/// 開始時に出力ディレクトリとタイムゾーンを確定させ、以降 `SessionManager::append` の
/// たびに Markdown ファイルを全文上書きする（インクリメンタル書き出し）。
/// アプリが finalize 前にクラッシュしても途中までの transcript がディスクに残る。
pub fn start_session_inner(
    manager: &SessionManager,
    title: String,
    started_at: u64,
    output_dir: &Path,
    offset: FixedOffset,
) -> Result<(), String> {
    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("出力ディレクトリの作成に失敗しました: {e}"))?;
    manager
        .start_with_output(title, started_at, output_dir.to_path_buf(), offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_session(
    title: String,
    state: tauri::State<'_, Arc<SessionManager>>,
    settings_state: tauri::State<'_, SettingsStateHandle>,
) -> Result<(), String> {
    let output_dir = resolve_output_directory(settings_state.inner());
    start_session_inner(
        state.inner().as_ref(),
        title,
        now_unix_secs(),
        &output_dir,
        default_offset(),
    )
}

// ─────────────────────────────────────────────
// finalize_and_save_session
// ─────────────────────────────────────────────

/// テスト可能な finalize_and_save_session 実装本体。
pub fn finalize_and_save_session_inner(
    manager: &SessionManager,
    output_dir: &Path,
    now_secs: u64,
    offset: FixedOffset,
) -> Result<PathBuf, String> {
    let session = manager.finalize(now_secs).map_err(|e| e.to_string())?;

    // 出力先ディレクトリが無い場合は作成する。
    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("出力ディレクトリの作成に失敗しました: {e}"))?;

    session_store::save_session_markdown(output_dir, &session, offset)
        .map_err(|e| format!("セッションファイルの書き込みに失敗しました: {e}"))
}

#[tauri::command]
pub fn finalize_and_save_session(
    state: tauri::State<'_, Arc<SessionManager>>,
    settings_state: tauri::State<'_, SettingsStateHandle>,
) -> Result<PathBuf, String> {
    let output_dir = resolve_output_directory(settings_state.inner());
    finalize_and_save_session_inner(
        state.inner().as_ref(),
        &output_dir,
        now_unix_secs(),
        default_offset(),
    )
}

// ─────────────────────────────────────────────
// discard_session
// ─────────────────────────────────────────────

/// テスト可能な discard_session 実装本体。
///
/// 開始途中で失敗した会議を保存せず破棄し、次の開始を妨げる活性セッションを残さない。
pub fn discard_session_inner(manager: &SessionManager) -> Result<(), String> {
    manager.discard().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn discard_session(state: tauri::State<'_, Arc<SessionManager>>) -> Result<(), String> {
    discard_session_inner(state.inner().as_ref())
}

// ─────────────────────────────────────────────
// list_session_summaries
// ─────────────────────────────────────────────

/// テスト可能な list_session_summaries 実装本体。
///
/// 初回起動時などでディレクトリが存在しないケースはエラーにせず空配列を返す。
pub fn list_session_summaries_inner(output_dir: &Path) -> Result<Vec<SessionSummary>, String> {
    if !output_dir.exists() {
        return Ok(Vec::new());
    }
    session_store::list_session_summaries(output_dir)
        .map_err(|e| format!("セッション一覧の取得に失敗しました: {e}"))
}

#[tauri::command]
pub fn list_session_summaries_cmd(
    settings_state: tauri::State<'_, SettingsStateHandle>,
) -> Result<Vec<SessionSummary>, String> {
    let output_dir = resolve_output_directory(settings_state.inner());
    list_session_summaries_inner(&output_dir)
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn list_md_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
            .collect()
    }

    // Cycle 1: finalize_and_save_session_inner が活性セッションを書き出せる
    #[test]
    fn finalize_and_save_session_inner_writes_markdown_with_expected_header() {
        let manager = SessionManager::new();
        // 1_713_333_000 UTC = 2024-04-17 14:50 JST
        manager
            .start("会議メモ".into(), 1_713_333_000)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        let dir = tempdir().unwrap();
        let path = finalize_and_save_session_inner(&manager, dir.path(), 1_713_333_100, jst())
            .expect("finalize_and_save should succeed");

        assert!(path.exists(), "written file should exist at {path:?}");
        let contents = std::fs::read_to_string(&path).unwrap();
        let first_line = contents.lines().next().unwrap();
        assert_eq!(first_line, "# 会議メモ - 2024-04-17 14:50");
        assert!(
            !manager.is_active(),
            "manager should be cleared after finalize"
        );
    }

    // Cycle 2: アイドル状態での finalize はエラー文字列を返す
    #[test]
    fn finalize_and_save_session_inner_returns_error_when_idle() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();

        let err = finalize_and_save_session_inner(&manager, dir.path(), 1_713_333_100, jst())
            .expect_err("idle manager should error");

        assert_eq!(err, "no active session");
    }

    #[test]
    fn discard_session_inner_clears_active_session_without_writing_file() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        start_session_inner(&manager, "会議".into(), 100, dir.path(), jst())
            .expect("start should succeed");

        discard_session_inner(&manager).expect("discard should succeed");

        assert!(!manager.is_active());
        let files = list_md_files(dir.path());
        assert!(
            files.is_empty(),
            "discard without appended transcript should not create files: {files:?}"
        );
    }

    #[test]
    fn discard_session_inner_returns_error_when_idle() {
        let manager = SessionManager::new();
        let err = discard_session_inner(&manager).expect_err("idle discard should error");
        assert_eq!(err, "no active session");
    }

    // Cycle 3a: start_session_inner でアイドルマネージャが活性化される
    #[test]
    fn start_session_inner_activates_idle_manager() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        assert!(!manager.is_active());

        start_session_inner(&manager, "会議".into(), 100, dir.path(), jst())
            .expect("start should succeed");

        assert!(manager.is_active());
        assert_eq!(manager.current_title(), Some("会議".into()));
    }

    // Cycle 3b: 既に活性なら "session already active" エラー
    #[test]
    fn start_session_inner_errors_when_already_active() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        start_session_inner(&manager, "first".into(), 100, dir.path(), jst()).expect("first start");

        let err = start_session_inner(&manager, "second".into(), 200, dir.path(), jst())
            .expect_err("second start should error");

        assert_eq!(err, "session already active");
        assert_eq!(manager.current_title(), Some("first".into()));
    }

    // start_session_inner が存在しないディレクトリを作成する
    #[test]
    fn start_session_inner_creates_output_directory_when_missing() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        let nested = dir.path().join("nested/deep");
        assert!(!nested.exists());

        start_session_inner(&manager, "会議".into(), 100, &nested, jst())
            .expect("start should succeed even when dir is missing");

        assert!(nested.exists(), "start should create the output directory");
    }

    // Cycle 4: list_session_summaries_inner が保存済みファイルを返す (スモーク)
    #[test]
    fn list_session_summaries_inner_returns_saved_summary() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("100-0.md"),
            "# 会議メモ - 2024-04-17 14:50\n",
        )
        .unwrap();

        let summaries = list_session_summaries_inner(dir.path()).expect("listing should succeed");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].started_at_secs, 100);
        assert_eq!(summaries[0].title, "会議メモ - 2024-04-17 14:50");
    }

    // 存在しないディレクトリは空配列を返す (初回起動時の UX)
    #[test]
    fn list_session_summaries_inner_returns_empty_for_missing_dir() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does_not_exist");

        let summaries =
            list_session_summaries_inner(&missing).expect("missing dir should not error");

        assert!(summaries.is_empty());
    }

    // Cycle 5a: output_dir がファイルの場合 create_dir_all が失敗し日本語エラーを返す
    // finalize は create_dir_all より先に呼ばれるため manager はアイドルに戻っている
    #[test]
    fn finalize_and_save_session_inner_returns_error_when_output_dir_path_is_a_file() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        let blocking_file = dir.path().join("blocking");
        std::fs::write(&blocking_file, b"existing content").unwrap();

        start_session_inner(&manager, "会議".into(), 100, dir.path(), jst())
            .expect("start should succeed");
        manager
            .append("user".to_string(), 5, "hello".to_string())
            .expect("append should succeed");

        let err = finalize_and_save_session_inner(&manager, &blocking_file, 1_713_333_100, jst())
            .expect_err("should error when path is a file not a directory");

        assert!(
            err.starts_with("出力ディレクトリの作成に失敗しました"),
            "unexpected error message: {err}"
        );
        // finalize() は create_dir_all より先に呼ばれるため manager はアイドルに戻っている
        assert!(!manager.is_active());
    }

    // Cycle 5b: output_dir がファイルの場合 list_session_summaries_inner が日本語エラーを返す
    #[test]
    fn list_session_summaries_inner_returns_error_when_path_is_a_file() {
        let dir = tempdir().unwrap();
        let blocking_file = dir.path().join("not_a_dir.txt");
        std::fs::write(&blocking_file, b"hello").unwrap();
        assert!(blocking_file.exists());
        assert!(blocking_file.is_file());

        let err = list_session_summaries_inner(&blocking_file)
            .expect_err("should error when path is a file not a directory");

        assert!(
            err.starts_with("セッション一覧の取得に失敗しました"),
            "unexpected error message: {err}"
        );
    }

    // Cycle 6a: start_session_inner が output_dir がファイルの場合に日本語エラーを返す
    // start_with_output より先に create_dir_all が失敗するため manager はアイドルのまま
    #[test]
    fn start_session_inner_returns_error_when_output_dir_path_is_a_file() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        let output_dir = dir.path().join("output_dir");
        std::fs::write(&output_dir, b"").unwrap();

        let err = start_session_inner(&manager, "title".into(), 1_713_333_000, &output_dir, jst())
            .expect_err("should error when output_dir path is a file");

        assert!(
            err.starts_with("出力ディレクトリの作成に失敗しました"),
            "unexpected error message: {err}"
        );
        // create_dir_all 失敗のため start_with_output は呼ばれず manager はアイドルのまま
        assert!(!manager.is_active());
    }

    // Cycle 6b: finalize_and_save_session_inner が save_session_markdown 失敗時に日本語エラーを返す
    // started_at = MAX_JS_DATE_UNIX_SECS + 1 は chrono 表現範囲外のため save が失敗する経路
    #[test]
    fn finalize_and_save_session_inner_returns_error_with_jp_prefix_when_save_fails() {
        let manager = SessionManager::new();
        // MAX_JS_DATE_UNIX_SECS + 1 = 8_640_000_000_001; chrono の NaiveDate 上限を超えるため
        // save_session_markdown が "out of range" エラーを返す
        manager
            .start("会議".into(), 8_640_000_000_001)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        let dir = tempdir().unwrap();
        let err = finalize_and_save_session_inner(&manager, dir.path(), 8_640_000_000_100, jst())
            .expect_err("should error when save_session_markdown fails");

        assert!(
            err.starts_with("セッションファイルの書き込みに失敗しました"),
            "unexpected error message: {err}"
        );
        // finalize() は create_dir_all より先に呼ばれるため、save 失敗後も manager はアイドル
        assert!(!manager.is_active());
    }

    fn build_settings_handle_with_dir(dir: Option<String>) -> SettingsStateHandle {
        use crate::settings::AppSettings;
        use parking_lot::Mutex;
        SettingsStateHandle(Mutex::new(AppSettings {
            output_directory: dir,
            ..AppSettings::default()
        }))
    }

    #[test]
    fn resolve_output_directory_returns_default_when_setting_is_none() {
        let handle = build_settings_handle_with_dir(None);
        let result = resolve_output_directory(&handle);
        assert_eq!(result, default_output_directory());
    }

    #[test]
    fn resolve_output_directory_returns_default_when_setting_is_empty() {
        let handle = build_settings_handle_with_dir(Some(String::new()));
        let result = resolve_output_directory(&handle);
        assert_eq!(result, default_output_directory());
    }

    #[test]
    fn resolve_output_directory_returns_setting_path_when_set_to_nonempty() {
        let handle = build_settings_handle_with_dir(Some("/tmp/custom-output".into()));
        let result = resolve_output_directory(&handle);
        assert_eq!(result, PathBuf::from("/tmp/custom-output"));
        assert_ne!(result, default_output_directory());
    }

    #[test]
    fn resolve_output_directory_does_not_trim_whitespace_in_setting_path() {
        let handle = build_settings_handle_with_dir(Some(" /tmp/path ".into()));
        let result = resolve_output_directory(&handle);
        assert_eq!(result, PathBuf::from(" /tmp/path "));
    }

    #[test]
    fn default_offset_returns_jst_offset_constant() {
        let offset = default_offset();
        assert_eq!(offset, FixedOffset::east_opt(9 * 3600).unwrap());
        assert_eq!(offset.local_minus_utc(), 9 * 3600);
    }

    #[test]
    fn start_session_inner_passes_empty_title_through_to_session_without_normalization() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();

        start_session_inner(&manager, String::new(), 1_700_000_000, dir.path(), jst())
            .expect("start_session_inner should succeed even with empty title");

        assert!(
            manager.is_active(),
            "空 title でも session が activate される: commands 層は title を加工しない passthrough 契約"
        );
        assert_eq!(
            manager.current_title(),
            Some(String::new()),
            "空 title が SessionManager::start_with_output へそのまま forwarded される passthrough 契約 (commands 層は空 title reject しない)"
        );
    }

    #[test]
    fn start_session_inner_passes_title_with_nul_bytes_through_without_sanitization() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        let nul_title = "\0\0\0".to_string();

        start_session_inner(
            &manager,
            nul_title.clone(),
            1_700_000_000,
            dir.path(),
            jst(),
        )
        .expect("start_session_inner should succeed even with NUL byte title");

        assert!(
            manager.is_active(),
            "NUL byte 含む title でも session が activate される: commands 層は control char filtering しない passthrough 契約"
        );
        assert_eq!(
            manager.current_title(),
            Some(nul_title),
            "NUL byte 含む title が SessionManager::start_with_output へそのまま forwarded される passthrough 契約"
        );
    }

    #[test]
    fn start_session_inner_passes_huge_title_through_without_size_limit() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        let huge_title = "a".repeat(10_000);

        start_session_inner(
            &manager,
            huge_title.clone(),
            1_700_000_000,
            dir.path(),
            jst(),
        )
        .expect("start_session_inner should succeed even with 10_000 char title");

        assert!(
            manager.is_active(),
            "10_000 chars title でも session が activate される: commands 層は size limit を持たない passthrough 契約"
        );
        let current = manager
            .current_title()
            .expect("current_title should be Some");
        assert_eq!(
            current.len(),
            10_000,
            "10_000 chars title が truncate されず forwarded される passthrough 契約 (size assert)"
        );
        assert_eq!(
            current, huge_title,
            "10_000 chars title が内容変換 (replace_all 等) されず forwarded される passthrough 契約 (内容 assert)"
        );
    }
}
