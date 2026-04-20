use crate::session::Session;
use std::sync::Mutex;

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

    pub fn start(&self, title: String, started_at: u64) -> Result<(), SessionManagerError> {
        let mut guard = self.current.lock().unwrap();
        if guard.is_some() {
            return Err(SessionManagerError::AlreadyActive);
        }
        *guard = Some(Session::start(title, started_at));
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.current.lock().unwrap().is_some()
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
}
