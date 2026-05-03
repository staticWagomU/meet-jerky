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
        let id = format!("{started_at}-{seq}");
        Self {
            id,
            title,
            started_at,
            ended_at: None,
            segments: Vec::new(),
        }
    }

    pub fn append_segment(&mut self, speaker: String, timestamp_offset_secs: u64, text: String) {
        self.segments.push(SessionSegment {
            speaker,
            timestamp_offset_secs,
            text,
        });
    }

    pub fn finalize(&mut self, ended_at: u64) {
        self.ended_at = Some(ended_at);
    }

    #[cfg(test)]
    pub fn is_finalized(&self) -> bool {
        self.ended_at.is_some()
    }

    #[cfg(test)]
    pub fn duration_secs(&self) -> Option<u64> {
        self.ended_at.map(|end| end.saturating_sub(self.started_at))
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

    #[test]
    fn finalize_sets_ended_at_and_duration_secs_reports_elapsed() {
        let mut session = Session::start("title".into(), 1000);
        assert!(!session.is_finalized());
        assert_eq!(session.duration_secs(), None);

        session.finalize(1300);

        assert!(session.is_finalized());
        assert_eq!(session.ended_at, Some(1300));
        assert_eq!(session.duration_secs(), Some(300));
    }

    #[test]
    fn duration_secs_saturates_when_end_precedes_start() {
        let mut session = Session::start("title".into(), 1000);

        session.finalize(900);

        assert_eq!(session.duration_secs(), Some(0));
    }

    #[test]
    fn append_segment_pushes_segments_in_order() {
        let mut session = Session::start("title".into(), 1000);
        session.append_segment("Alice".into(), 5, "hello".into());
        session.append_segment("Bob".into(), 12, "world".into());

        assert_eq!(session.segments.len(), 2);
        assert_eq!(session.segments[0].speaker, "Alice");
        assert_eq!(session.segments[0].timestamp_offset_secs, 5);
        assert_eq!(session.segments[0].text, "hello");
        assert_eq!(session.segments[1].speaker, "Bob");
        assert_eq!(session.segments[1].timestamp_offset_secs, 12);
        assert_eq!(session.segments[1].text, "world");
    }

    #[test]
    fn start_assigns_unique_ids_across_consecutive_calls() {
        let s1 = Session::start("title".into(), 9000000000);
        let s2 = Session::start("title".into(), 9000000000);
        let s3 = Session::start("title".into(), 9000000000);

        assert_ne!(s1.id, s2.id, "連続生成した id は衝突しない契約");
        assert_ne!(s2.id, s3.id, "連続生成した id は衝突しない契約");
        assert_ne!(s1.id, s3.id, "連続生成した id は衝突しない契約");
    }

    #[test]
    fn start_id_starts_with_started_at_prefix_and_hyphen() {
        let session = Session::start("title".into(), 1700000000);

        assert!(
            session.id.starts_with("1700000000-"),
            "id は started_at で始まる契約 (session_store の parse_session_started_at_secs の前提): got {}",
            session.id
        );
        assert!(
            session.id.contains('-'),
            "id に '-' が含まれる契約: got {}",
            session.id
        );
    }

    #[test]
    fn append_segment_after_finalize_records_post_finalize_segment() {
        let mut session = Session::start("title".into(), 1000);
        session.append_segment("pre-finalize-speaker".into(), 5, "before".into());
        session.finalize(1300);
        session.append_segment("post-finalize-speaker".into(), 10, "after".into());

        assert!(session.is_finalized(), "finalize 後の状態は変わらない");
        assert_eq!(
            session.segments.len(),
            2,
            "finalize 後の append も segments に push される"
        );
        assert_eq!(
            session.segments[1].speaker, "post-finalize-speaker",
            "finalize 後の append が確実に push される契約"
        );
    }

    #[test]
    fn finalize_called_twice_overwrites_ended_at_with_latest_value() {
        let mut session = Session::start("title".into(), 1000);

        session.finalize(1300);
        assert_eq!(
            session.ended_at,
            Some(1300),
            "1 回目 finalize 後の ended_at"
        );
        assert_eq!(
            session.duration_secs(),
            Some(300),
            "1 回目 finalize 後の duration_secs"
        );

        session.finalize(1500);
        assert_eq!(
            session.ended_at,
            Some(1500),
            "2 回目 finalize で後勝ち上書き"
        );
        assert_eq!(
            session.duration_secs(),
            Some(500),
            "2 回目 finalize 後の duration_secs"
        );
    }
}
