use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSegment {
    pub speaker: String,
    pub timestamp_offset_secs: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub segments: Vec<SessionSegment>,
}

impl Session {
    pub fn start(title: String, started_at: u64) -> Self {
        let seq = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
        let id = format!("{}-{}", started_at, seq);
        Self {
            id,
            title,
            started_at,
            ended_at: None,
            segments: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_creates_session_with_initial_state() {
        let session = Session::start("title".into(), 1000);
        assert!(!session.id.is_empty(), "id should be non-empty");
        assert_eq!(session.title, "title");
        assert_eq!(session.started_at, 1000);
        assert!(session.segments.is_empty());
        assert_eq!(session.ended_at, None);
    }
}
