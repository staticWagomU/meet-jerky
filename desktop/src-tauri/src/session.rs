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

    // SESSION_COUNTER の AtomicU64 fetch_add(1, Relaxed) による monotonic 契約。
    // session_store の id 順序前提。絶対値は test 順依存で不問。
    #[test]
    fn start_assigns_strictly_increasing_seq_in_id_suffix() {
        let s1 = Session::start("title".into(), 1_700_000_000);
        let s2 = Session::start("title".into(), 1_700_000_000);
        let s3 = Session::start("title".into(), 1_700_000_000);

        let parse_seq = |s: &Session| -> u64 { s.id.split_once('-').unwrap().1.parse().unwrap() };
        let (q1, q2, q3) = (parse_seq(&s1), parse_seq(&s2), parse_seq(&s3));

        assert!(
            q1 < q2,
            "seq は strictly increasing: {q1} < {q2} である契約"
        );
        assert!(
            q2 < q3,
            "seq は strictly increasing: {q2} < {q3} である契約"
        );
    }

    // `#[derive(Clone)]` が Vec の deep copy であることを文書化。
    // `Rc<Vec<_>>` 等への変更検知装置。
    #[test]
    fn clone_creates_independent_segments_vec_for_deep_copy_contract() {
        let mut a = Session::start("title".into(), 1_000);
        a.append_segment("Alice".into(), 1, "hello".into());
        a.append_segment("Bob".into(), 2, "world".into());

        let mut b = a.clone();

        a.append_segment("Alice".into(), 3, "from_a".into());
        b.append_segment("Bob".into(), 3, "from_b".into());

        assert_eq!(a.segments.len(), 3, "a には 3 件の segments がある契約");
        assert_eq!(b.segments.len(), 3, "b には 3 件の segments がある契約");
        assert_ne!(
            a.segments[2].text, b.segments[2].text,
            "clone 後の追加が互いに独立している契約"
        );
        assert_eq!(
            a.segments[0].text, b.segments[0].text,
            "clone 時点の segment[0] は同じ内容である契約"
        );
        assert_eq!(
            a.segments[1].text, b.segments[1].text,
            "clone 時点の segment[1] は同じ内容である契約"
        );
    }

    // SessionSegment は 3 field 持つ薄いデータコンテナで、clone は全 field を independently に copy する契約。
    #[test]
    fn session_segment_clone_preserves_all_three_fields_independently() {
        let s = SessionSegment {
            speaker: "Alice".into(),
            timestamp_offset_secs: 42,
            text: "hi".into(),
        };
        let c = s.clone();
        assert_eq!(s.speaker, c.speaker, "speaker が clone で保持される契約");
        assert_eq!(s.speaker, "Alice");
        assert_eq!(
            s.timestamp_offset_secs, c.timestamp_offset_secs,
            "timestamp_offset_secs が clone で保持される契約"
        );
        assert_eq!(s.timestamp_offset_secs, 42);
        assert_eq!(s.text, c.text, "text が clone で保持される契約");
        assert_eq!(s.text, "hi");

        // 空文字 + offset=0 のケース
        let empty = SessionSegment {
            speaker: String::new(),
            timestamp_offset_secs: 0,
            text: String::new(),
        };
        let empty_c = empty.clone();
        assert_eq!(
            empty.speaker, empty_c.speaker,
            "空 speaker の clone 同等契約"
        );
        assert_eq!(
            empty.timestamp_offset_secs, empty_c.timestamp_offset_secs,
            "offset=0 の clone 同等契約"
        );
        assert_eq!(empty.text, empty_c.text, "空 text の clone 同等契約");

        // u64::MAX offset + multibyte のケース
        let big = SessionSegment {
            speaker: "あ".into(),
            timestamp_offset_secs: u64::MAX,
            text: "あ".into(),
        };
        let big_c = big.clone();
        assert_eq!(
            big.speaker, big_c.speaker,
            "multibyte speaker の clone 同等契約"
        );
        assert_eq!(
            big.timestamp_offset_secs, big_c.timestamp_offset_secs,
            "offset=u64::MAX の clone 同等契約"
        );
        assert_eq!(big.text, big_c.text, "multibyte text の clone 同等契約");
    }

    // `#[derive(Serialize, Deserialize)]` の正常動作を 4 状態組合せで固定。
    // session_store に書き出される persistent 形式の構造契約。
    #[test]
    fn serde_json_round_trip_preserves_all_fields_for_4_state_combinations() {
        // ケース 1: segments=0 件 + ended_at=None
        let s1 = Session::start("title1".into(), 1_000);
        let r1: Session = serde_json::from_str(&serde_json::to_string(&s1).unwrap()).unwrap();
        assert_eq!(s1.id, r1.id);
        assert_eq!(s1.title, r1.title);
        assert_eq!(s1.started_at, r1.started_at);
        assert_eq!(
            r1.ended_at, None,
            "ended_at=None が round-trip で保持される契約"
        );
        assert_eq!(
            r1.segments.len(),
            0,
            "segments=0 件が round-trip で保持される契約"
        );

        // ケース 2: segments=2 件 + ended_at=None
        let mut s2 = Session::start("title2".into(), 2_000);
        s2.append_segment("Alice".into(), 5, "hello".into());
        s2.append_segment("Bob".into(), 10, "world".into());
        let r2: Session = serde_json::from_str(&serde_json::to_string(&s2).unwrap()).unwrap();
        assert_eq!(s2.id, r2.id);
        assert_eq!(r2.ended_at, None);
        assert_eq!(r2.segments.len(), 2);
        assert_eq!(r2.segments[0].speaker, "Alice");
        assert_eq!(r2.segments[0].timestamp_offset_secs, 5);
        assert_eq!(r2.segments[0].text, "hello");
        assert_eq!(r2.segments[1].speaker, "Bob");
        assert_eq!(r2.segments[1].timestamp_offset_secs, 10);
        assert_eq!(r2.segments[1].text, "world");

        // ケース 3: segments=0 件 + ended_at=Some(1500)
        let mut s3 = Session::start("title3".into(), 3_000);
        s3.finalize(1_500);
        let r3: Session = serde_json::from_str(&serde_json::to_string(&s3).unwrap()).unwrap();
        assert_eq!(s3.id, r3.id);
        assert_eq!(
            r3.ended_at,
            Some(1_500),
            "ended_at=Some(1500) が round-trip で保持される契約"
        );
        assert_eq!(r3.segments.len(), 0);

        // ケース 4: segments=2 件 + ended_at=Some(1500)
        let mut s4 = Session::start("title4".into(), 4_000);
        s4.append_segment("Carol".into(), 3, "foo".into());
        s4.append_segment("Dave".into(), 7, "bar".into());
        s4.finalize(1_500);
        let r4: Session = serde_json::from_str(&serde_json::to_string(&s4).unwrap()).unwrap();
        assert_eq!(s4.id, r4.id);
        assert_eq!(r4.ended_at, Some(1_500));
        assert_eq!(r4.segments.len(), 2);
        assert_eq!(r4.segments[0].speaker, "Carol");
        assert_eq!(r4.segments[0].timestamp_offset_secs, 3);
        assert_eq!(r4.segments[0].text, "foo");
        assert_eq!(r4.segments[1].speaker, "Dave");
        assert_eq!(r4.segments[1].timestamp_offset_secs, 7);
        assert_eq!(r4.segments[1].text, "bar");
    }

    // `format!("{started_at}-{seq}")` の boundary を u64 両端で固定。
    // `as` キャストや try_into を入れる誤改修の検知装置。
    #[test]
    fn start_with_zero_and_max_u64_started_at_passes_through_to_id_prefix_and_field() {
        // ケース 1: started_at=0
        let s0 = Session::start("t".into(), 0);
        assert!(
            s0.id.starts_with("0-"),
            "started_at=0 の id prefix が '0-' である契約: got {}",
            s0.id
        );
        assert_eq!(
            s0.started_at, 0,
            "started_at=0 が field に passthrough される契約"
        );
        assert_eq!(s0.ended_at, None);
        assert!(s0.segments.is_empty());
        assert!(!s0.id.is_empty());

        // ケース 2: started_at=u64::MAX
        let s_max = Session::start("t".into(), u64::MAX);
        let expected_prefix = format!("{}-", u64::MAX);
        assert!(
            s_max.id.starts_with(&expected_prefix),
            "started_at=u64::MAX の id prefix が '{expected_prefix}' である契約: got {}",
            s_max.id
        );
        assert_eq!(
            s_max.started_at,
            u64::MAX,
            "started_at=u64::MAX が field に passthrough される契約"
        );
        assert_eq!(s_max.ended_at, None);
        assert!(s_max.segments.is_empty());
        assert!(!s_max.id.is_empty());
    }

    #[test]
    fn session_segment_debug_output_contains_struct_name_and_all_three_field_names() {
        let segment = SessionSegment {
            speaker: "alice".to_string(),
            timestamp_offset_secs: 42,
            text: "hi".to_string(),
        };
        let output = format!("{:?}", segment);
        assert!(
            output.contains("SessionSegment"),
            "型名 'SessionSegment' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("speaker"),
            "field 名 'speaker' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("timestamp_offset_secs"),
            "field 名 'timestamp_offset_secs' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("text"),
            "field 名 'text' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("alice"),
            "値 'alice' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("42"),
            "値 '42' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("hi"),
            "値 'hi' が Debug 出力に含まれる契約: got {}",
            output
        );
    }

    #[test]
    fn session_debug_output_contains_struct_name_and_all_five_field_names_including_options_and_vec(
    ) {
        let session = Session::start("Daily".to_string(), 1_234_567_890);
        let output = format!("{:?}", session);
        assert!(
            output.contains("Session"),
            "型名 'Session' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("id"),
            "field 名 'id' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("title"),
            "field 名 'title' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("started_at"),
            "field 名 'started_at' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("ended_at"),
            "field 名 'ended_at' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("segments"),
            "field 名 'segments' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("Daily"),
            "値 'Daily' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("1234567890"),
            "値 '1234567890' が Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("None"),
            "Option::None が 'None' として Debug 出力に含まれる契約: got {}",
            output
        );
        assert!(
            output.contains("[]"),
            "空 Vec が '[]' として Debug 出力に含まれる契約: got {}",
            output
        );
    }

    #[test]
    fn session_segment_debug_output_equals_after_clone_for_all_field_types() {
        let original = SessionSegment {
            speaker: "bob".to_string(),
            timestamp_offset_secs: 100,
            text: "hello world".to_string(),
        };
        let cloned = original.clone();
        assert_eq!(
            format!("{:?}", original),
            format!("{:?}", cloned),
            "#[derive(Debug, Clone)] の組み合わせで Debug 出力が clone 後も完全一致する契約"
        );
    }
}
