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
                if let Some(output) = &active.output {
                    // ディスク書き出しエラーは in-memory の一貫性を壊さないよう、ログに留める。
                    // Phase 5 時点では tracing 未導入のため eprintln で暫定対応。
                    if let Err(err) = session_store::write_session_markdown_to(
                        &output.path,
                        &active.session,
                        output.offset,
                    ) {
                        eprintln!(
                            "[session_manager] failed to persist session to {:?}: {}",
                            output.path, err
                        );
                    }
                }
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
                if let Some(output) = &active.output {
                    if let Err(err) = session_store::write_session_markdown_to(
                        &output.path,
                        &active.session,
                        output.offset,
                    ) {
                        eprintln!(
                            "[session_manager] failed to persist finalized session to {:?}: {}",
                            output.path, err
                        );
                    }
                }
                Ok(active.session)
            }
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
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
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

        // 活性中のファイル名を推測するため、ディレクトリを走査して .md を探す。
        let files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
            .collect();
        assert_eq!(files.len(), 1, "exactly one .md should exist: {:?}", files);

        let contents = std::fs::read_to_string(&files[0]).unwrap();
        assert!(
            contents.contains("**[14:50:15] 自分:** hello"),
            "segment line missing after append. contents=\n{}",
            contents
        );
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
