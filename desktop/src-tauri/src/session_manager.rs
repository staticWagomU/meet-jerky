use crate::session::Session;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SessionManagerError {
    #[error("session already active")]
    AlreadyActive,
    #[error("no active session")]
    NotActive,
}

pub struct SessionManager {
    current: Mutex<Option<Session>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Session>> {
        self.current.lock().expect("session manager mutex poisoned")
    }

    pub fn start(&self, title: String, started_at: u64) -> Result<(), SessionManagerError> {
        let mut guard = self.lock();
        if guard.is_some() {
            return Err(SessionManagerError::AlreadyActive);
        }
        *guard = Some(Session::start(title, started_at));
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
            Some(session) => {
                session.append_segment(speaker, offset_secs, text);
                Ok(())
            }
            None => Err(SessionManagerError::NotActive),
        }
    }

    pub fn finalize(&self, ended_at: u64) -> Result<Session, SessionManagerError> {
        let mut guard = self.lock();
        match guard.take() {
            Some(mut session) => {
                session.finalize(ended_at);
                Ok(session)
            }
            None => Err(SessionManagerError::NotActive),
        }
    }

    pub fn is_active(&self) -> bool {
        self.lock().is_some()
    }

    pub fn current_title(&self) -> Option<String> {
        self.lock().as_ref().map(|s| s.title.clone())
    }

    pub fn current_segment_count(&self) -> Option<usize> {
        self.lock().as_ref().map(|s| s.segments.len())
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
