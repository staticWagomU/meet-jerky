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

    // append_segment は segments のみ変更し他フィールドは変えない cross-fn invariant 契約
    #[test]
    fn append_segment_preserves_started_at_id_and_title_invariants() {
        let mut session = Session::start("会議メモ".into(), 1_000);
        let original_id = session.id.clone();
        let original_started_at = session.started_at;
        let original_title = session.title.clone();

        for i in 0u64..5 {
            session.append_segment(format!("speaker{i}"), i, format!("text{i}"));
        }

        assert_eq!(session.id, original_id, "append_segment は id を変えない");
        assert_eq!(
            session.started_at, original_started_at,
            "append_segment は started_at を変えない"
        );
        assert_eq!(
            session.title, original_title,
            "append_segment は title を変えない"
        );
        assert_eq!(
            session.ended_at, None,
            "append_segment は ended_at に触らない"
        );
        assert_eq!(session.segments.len(), 5, "append された segment 数は維持");
    }

    // finalize は ended_at のみ変更し segments / started_at / id は変えない cross-fn invariant 契約
    #[test]
    fn finalize_preserves_started_at_and_segments_invariants() {
        let mut session = Session::start("title".into(), 1_000);
        session.append_segment("Alice".into(), 5, "hello".into());
        session.append_segment("Bob".into(), 12, "world".into());

        let original_id = session.id.clone();
        let original_started_at = session.started_at;
        let original_segments_len = session.segments.len();
        let original_first_text = session.segments[0].text.clone();

        session.finalize(2_000);

        assert_eq!(session.id, original_id, "finalize は id を変えない");
        assert_eq!(
            session.started_at, original_started_at,
            "finalize は started_at を変えない"
        );
        assert_eq!(
            session.segments.len(),
            original_segments_len,
            "finalize は segments の長さを変えない"
        );
        assert_eq!(
            session.segments[0].text, original_first_text,
            "finalize は既存 segment 内容を変えない"
        );
        assert_eq!(
            session.ended_at,
            Some(2_000),
            "finalize は ended_at だけを設定する"
        );
    }

    // title の validation/normalization は上位層責任 — Session::start は空文字を passthrough する契約
    #[test]
    fn start_accepts_empty_title_as_passthrough() {
        let session = Session::start(String::new(), 1_000);
        assert_eq!(
            session.title, "",
            "Session::start は title バリデーションせず空文字を passthrough"
        );
        assert_eq!(session.started_at, 1_000);
        assert!(!session.id.is_empty(), "title が空でも id は生成される");
        assert!(session.segments.is_empty());
        assert_eq!(session.ended_at, None);
    }

    // speaker/text の fallback は normalize_speaker (transcript_bridge.rs) の責務 — append_segment は passthrough のみ
    #[test]
    fn append_segment_accepts_empty_speaker_and_text_as_passthrough() {
        let mut session = Session::start("title".into(), 1_000);
        session.append_segment(String::new(), 5, String::new());

        assert_eq!(
            session.segments.len(),
            1,
            "空文字 speaker/text でも segment は push される"
        );
        assert_eq!(
            session.segments[0].speaker, "",
            "speaker の空文字は passthrough"
        );
        assert_eq!(session.segments[0].text, "", "text の空文字は passthrough");
        assert_eq!(session.segments[0].timestamp_offset_secs, 5);
    }

    // timestamp_offset_secs は u64 全範囲を許容する現契約を boundary 値 (0 と u64::MAX) で固定
    #[test]
    fn append_segment_accepts_zero_and_max_u64_offset_as_passthrough() {
        let mut session = Session::start("title".into(), 1_000);
        session.append_segment("a".into(), 0, "zero".into());
        session.append_segment("b".into(), u64::MAX, "max".into());

        assert_eq!(session.segments.len(), 2);
        assert_eq!(
            session.segments[0].timestamp_offset_secs, 0,
            "offset=0 boundary を passthrough"
        );
        assert_eq!(
            session.segments[1].timestamp_offset_secs,
            u64::MAX,
            "offset=u64::MAX boundary を passthrough"
        );
    }
}
