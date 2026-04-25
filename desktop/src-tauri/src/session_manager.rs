use crate::session::Session;
use crate::session_store;
use chrono::FixedOffset;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SessionManagerError {
    #[error("session already active")]
    AlreadyActive,
    #[error("no active session")]
    NotActive,
}

/// 活性セッションの状態。
///
/// `output` が `Some` の場合、`append`/`finalize` ごとに対応ファイルへ全文書き出しを行う
/// （インクリメンタル書き出し）。`None` の場合は in-memory のみで動作する。
struct ActiveSession {
    session: Session,
    output: Option<ActiveOutput>,
}

struct ActiveOutput {
    path: PathBuf,
    offset: FixedOffset,
}

pub struct SessionManager {
    current: Mutex<Option<ActiveSession>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<ActiveSession>> {
        self.current.lock().expect("session manager mutex poisoned")
    }

    /// in-memory のみでセッションを開始する。ディスク書き出しは行わない。
    pub fn start(&self, title: String, started_at: u64) -> Result<(), SessionManagerError> {
        let mut guard = self.lock();
        if guard.is_some() {
            return Err(SessionManagerError::AlreadyActive);
        }
        *guard = Some(ActiveSession {
            session: Session::start(title, started_at),
            output: None,
        });
        Ok(())
    }

    /// 出力ディレクトリとタイムゾーンを指定して開始する。
    ///
    /// `append` / `finalize` のたびに `<output_dir>/<session_id>.md` を上書きするため、
    /// アプリが `finalize` 前にクラッシュしても途中までの transcript がディスクに残る。
    pub fn start_with_output(
        &self,
        title: String,
        started_at: u64,
        output_dir: PathBuf,
        offset: FixedOffset,
    ) -> Result<(), SessionManagerError> {
        let mut guard = self.lock();
        if guard.is_some() {
            return Err(SessionManagerError::AlreadyActive);
        }
        let session = Session::start(title, started_at);
        let path = session_store::path_for_session(&output_dir, &session);
        *guard = Some(ActiveSession {
            session,
            output: Some(ActiveOutput { path, offset }),
        });
        Ok(())
    }

    pub fn append(
        &self,
        speaker: String,
        offset_secs: u64,
        text: String,
    ) -> Result<(), SessionManagerError> {
        let mut guard = self.lock();
        match guard.as_mut() {
            Some(active) => {
                active.session.append_segment(speaker, offset_secs, text);
                persist_if_configured(active, "append");
                Ok(())
            }
            None => Err(SessionManagerError::NotActive),
        }
    }

    pub fn finalize(&self, ended_at: u64) -> Result<Session, SessionManagerError> {
        let mut guard = self.lock();
        match guard.take() {
            Some(mut active) => {
                active.session.finalize(ended_at);
                persist_if_configured(&active, "finalize");
                Ok(active.session)
            }
            None => Err(SessionManagerError::NotActive),
        }
    }

    /// 活性セッションを保存せず破棄する。
    ///
    /// 会議開始シーケンスの途中で音声取得や文字起こし開始に失敗した場合、
    /// 空の履歴ファイルを残さずに `session already active` 状態を解消するために使う。
    pub fn discard(&self) -> Result<(), SessionManagerError> {
        let mut guard = self.lock();
        match guard.take() {
            Some(_) => Ok(()),
            None => Err(SessionManagerError::NotActive),
        }
    }

    pub fn is_active(&self) -> bool {
        self.lock().is_some()
    }

    pub fn current_title(&self) -> Option<String> {
        self.lock().as_ref().map(|a| a.session.title.clone())
    }

    pub fn current_segment_count(&self) -> Option<usize> {
        self.lock().as_ref().map(|a| a.session.segments.len())
    }

    /// 活性セッションの `started_at` (unix 秒)。非活性時は `None`。
    ///
    /// ライブ loop 側で「セッションが開始していれば offset を計算して append」、
    /// 未開始なら skip する判定に使う。
    pub fn current_started_at_secs(&self) -> Option<u64> {
        self.lock().as_ref().map(|a| a.session.started_at)
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 出力設定がある場合のみ、現在のセッションを Markdown としてディスクへ書き出す。
///
/// ディスク書き出しエラーは in-memory の一貫性を壊さないよう、ログに留めて無視する。
/// Phase 5 時点では tracing 未導入のため eprintln で暫定対応。
/// `phase` は append/finalize などの呼び出し文脈をログに残すためのラベル。
fn persist_if_configured(active: &ActiveSession, phase: &str) {
    if let Some(output) = &active.output {
        if let Err(err) = session_store::write_session_markdown_to(
            &output.path,
            &active.session,
            output.offset,
        ) {
            eprintln!(
                "[session_manager] failed to persist session on {} to {:?}: {}",
                phase, output.path, err
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    /// 指定ディレクトリ直下の `.md` ファイルを列挙する。
    fn list_md_files(dir: &std::path::Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
            .collect()
    }

    #[test]
    fn append_writes_segment_to_disk_when_started_with_output() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        manager
            .start_with_output(
                "会議メモ".into(),
                1_713_333_000, // 2024-04-17 14:50 JST
                dir.path().to_path_buf(),
                jst(),
            )
            .expect("start should succeed");

        manager
            .append("自分".into(), 15, "hello".into())
            .expect("append should succeed");

        let files = list_md_files(dir.path());
        assert_eq!(files.len(), 1, "exactly one .md should exist: {:?}", files);

        let contents = std::fs::read_to_string(&files[0]).unwrap();
        assert!(
            contents.contains("**[14:50:15] 自分:** hello"),
            "segment line missing after append. contents=\n{}",
            contents
        );
    }

    #[test]
    fn second_append_preserves_first_segment_on_disk() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        manager
            .start_with_output(
                "会議メモ".into(),
                1_713_333_000,
                dir.path().to_path_buf(),
                jst(),
            )
            .expect("start should succeed");

        manager.append("自分".into(), 5, "一言目".into()).unwrap();
        manager.append("相手".into(), 12, "二言目".into()).unwrap();

        let files = list_md_files(dir.path());
        assert_eq!(files.len(), 1);
        let contents = std::fs::read_to_string(&files[0]).unwrap();

        assert!(
            contents.contains("**[14:50:05] 自分:** 一言目"),
            "first segment lost. contents=\n{}",
            contents
        );
        assert!(
            contents.contains("**[14:50:12] 相手:** 二言目"),
            "second segment missing. contents=\n{}",
            contents
        );
    }

    #[test]
    fn finalize_disk_contents_match_in_memory_session() {
        // append 後と finalize 後でディスク内容が同一であることで、
        // "最終保存 = 最後の append 時点 + finalize マーク" が成立することを示す。
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        manager
            .start_with_output(
                "会議メモ".into(),
                1_713_333_000,
                dir.path().to_path_buf(),
                jst(),
            )
            .expect("start should succeed");
        manager.append("自分".into(), 5, "一言目".into()).unwrap();
        manager.append("相手".into(), 12, "二言目".into()).unwrap();

        let files_before = list_md_files(dir.path());
        assert_eq!(files_before.len(), 1);
        let path = files_before[0].clone();
        let before = std::fs::read_to_string(&path).unwrap();

        let session = manager.finalize(1_713_333_100).expect("finalize");
        let after = std::fs::read_to_string(&path).unwrap();

        // 全セグメントがディスクに残っている
        assert!(after.contains("**[14:50:05] 自分:** 一言目"));
        assert!(after.contains("**[14:50:12] 相手:** 二言目"));
        // finalize 時点で最後の append と同じ内容が保持されている
        // （現状 finalize では ended_at は markdown に出さないため一致するはず）
        assert_eq!(
            before, after,
            "finalize should leave last-append contents intact"
        );
        // in-memory session と segments が一致
        assert_eq!(session.segments.len(), 2);
        assert_eq!(session.segments[0].text, "一言目");
        assert_eq!(session.segments[1].text, "二言目");
    }

    #[test]
    fn new_has_no_active_session_and_start_activates_it() {
        let manager = SessionManager::new();
        assert!(!manager.is_active());

        manager.start("meeting".into(), 100).expect("start should succeed");

        assert!(manager.is_active());
    }

    #[test]
    fn finalize_clears_state_and_subsequent_finalize_errors() {
        let manager = SessionManager::new();
        manager.start("meeting".into(), 100).expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        let session = manager.finalize(200).expect("finalize should succeed");

        assert_eq!(session.title, "meeting");
        assert_eq!(session.ended_at, Some(200));
        assert_eq!(session.segments.len(), 1);
        assert!(!manager.is_active());

        let err = manager.finalize(300).expect_err("second finalize should fail");
        assert_eq!(err, SessionManagerError::NotActive);
    }

    #[test]
    fn discard_clears_active_session_without_finalizing() {
        let manager = SessionManager::new();
        manager.start("meeting".into(), 100).expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        manager.discard().expect("discard should succeed");

        assert!(!manager.is_active());
        let err = manager.finalize(200).expect_err("finalize after discard should fail");
        assert_eq!(err, SessionManagerError::NotActive);
    }

    #[test]
    fn discard_when_idle_returns_not_active() {
        let manager = SessionManager::new();
        let err = manager.discard().expect_err("idle discard should fail");
        assert_eq!(err, SessionManagerError::NotActive);
    }

    #[test]
    fn append_without_start_returns_not_active_and_append_after_start_retains_segment() {
        let manager = SessionManager::new();

        let err = manager
            .append("Alice".into(), 5, "hello".into())
            .expect_err("append before start should fail");
        assert_eq!(err, SessionManagerError::NotActive);

        manager.start("meeting".into(), 100).expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed after start");

        assert_eq!(manager.current_segment_count(), Some(1));
    }

    #[test]
    fn start_twice_returns_already_active_and_retains_first_session() {
        let manager = SessionManager::new();
        manager.start("first".into(), 100).expect("first start should succeed");

        let err = manager.start("second".into(), 200).expect_err("second start should fail");

        assert_eq!(err, SessionManagerError::AlreadyActive);
        assert_eq!(manager.current_title(), Some("first".into()));
    }
}
