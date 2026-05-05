use std::sync::Arc;

use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};

/// 1 つのストリーミング文字起こしセッションの設定。
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// 入力音声のサンプルレート。エンジン内部で必要に応じてリサンプルする。
    pub sample_rate: u32,
    /// 出力セグメントに付与する話者ラベル ("自分" / "相手側" など)。
    pub speaker: Option<String>,
    /// 入力音声ソース。ライブ UI がマイク/システム音声を表示上で識別するために使う。
    pub source: Option<TranscriptionSource>,
    /// 言語ヒント ("ja" / "en" / "auto")。エンジンが解釈する。
    pub language: Option<String>,
}

/// マイク / システム音声など、複数の音声ソースに対する文字起こしを行う
/// エンジンのファクトリ。
///
/// `start_stream` は呼び出すたびに独立した `TranscriptionStream` を返し、
/// 並行して複数のストリームを動かせる必要がある (マイク + システム音声)。
pub trait TranscriptionEngine: Send + Sync {
    fn start_stream(
        self: Arc<Self>,
        config: StreamConfig,
    ) -> Result<Box<dyn TranscriptionStream>, String>;
}

/// ストリーミング文字起こしの 1 セッションを表す。
///
/// 呼び出し元は raw PCM サンプルを `feed` で送り込み、確定した
/// セグメントを `drain_segments` で非同期に取り出す。`finalize` で
/// 残りのバッファをフラッシュして最終セグメントを得る。
///
/// 実装はサンプルレート変換やチャンク化、API 呼び出しなどの
/// エンジン固有の責務をすべて内部に閉じ込める。
pub trait TranscriptionStream: Send {
    /// `StreamConfig::sample_rate` で指定したレートのサンプルを送り込む。
    fn feed(&mut self, samples: &[f32]) -> Result<(), String>;

    /// これまでに確定したセグメントを取り出す (非ブロッキング)。
    fn drain_segments(&mut self) -> Vec<TranscriptionSegment>;

    /// 残りのバッファを処理し、最終セグメントを返す。
    /// 呼び出し後はストリームを使わない。
    fn finalize(self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription_types::{TranscriptionSegment, TranscriptionSource};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // ─────────────────────────────────────────
    // TranscriptionEngine / TranscriptionStream trait テスト
    // ─────────────────────────────────────────
    //
    // Whisper の実モデルをロードせずに trait の振る舞いを検証する。
    // モックエンジンが受け取ったサンプル数とライフサイクル (feed → drain →
    // finalize) を記録し、新 trait の契約が壊れていないことを確認する。

    /// テスト用モックエンジン。`feed` で受け取ったサンプル合計を記録し、
    /// `feed` 1 回ごとに 1 セグメントを出す。`finalize` 時には特殊セグメントを 1 つ追加する。
    struct MockEngine {
        feeds_seen: Arc<AtomicUsize>,
        samples_seen: Arc<AtomicUsize>,
    }

    struct MockStream {
        speaker: Option<String>,
        source: Option<TranscriptionSource>,
        feeds_seen: Arc<AtomicUsize>,
        samples_seen: Arc<AtomicUsize>,
        pending: Vec<TranscriptionSegment>,
    }

    impl TranscriptionEngine for MockEngine {
        fn start_stream(
            self: Arc<Self>,
            config: StreamConfig,
        ) -> Result<Box<dyn TranscriptionStream>, String> {
            Ok(Box::new(MockStream {
                speaker: config.speaker,
                source: config.source,
                feeds_seen: Arc::clone(&self.feeds_seen),
                samples_seen: Arc::clone(&self.samples_seen),
                pending: Vec::new(),
            }))
        }
    }

    impl TranscriptionStream for MockStream {
        fn feed(&mut self, samples: &[f32]) -> Result<(), String> {
            self.feeds_seen.fetch_add(1, Ordering::SeqCst);
            self.samples_seen.fetch_add(samples.len(), Ordering::SeqCst);
            self.pending.push(TranscriptionSegment {
                text: format!("feed-{}", self.feeds_seen.load(Ordering::SeqCst)),
                start_ms: 0,
                end_ms: 100,
                source: self.source,
                speaker: self.speaker.clone(),
                is_error: None,
            });
            Ok(())
        }

        fn drain_segments(&mut self) -> Vec<TranscriptionSegment> {
            std::mem::take(&mut self.pending)
        }

        fn finalize(mut self: Box<Self>) -> Result<Vec<TranscriptionSegment>, String> {
            self.pending.push(TranscriptionSegment {
                text: "finalized".to_string(),
                start_ms: 0,
                end_ms: 0,
                source: self.source,
                speaker: self.speaker.clone(),
                is_error: None,
            });
            Ok(std::mem::take(&mut self.pending))
        }
    }

    #[test]
    fn test_stream_lifecycle_feed_drain_finalize() {
        let feeds = Arc::new(AtomicUsize::new(0));
        let samples = Arc::new(AtomicUsize::new(0));
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::clone(&feeds),
            samples_seen: Arc::clone(&samples),
        });

        let mut stream = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("自分".to_string()),
                source: Some(TranscriptionSource::Microphone),
                language: Some("ja".to_string()),
            })
            .expect("start_stream should succeed");

        // feed を 2 回実行
        stream.feed(&vec![0.0_f32; 100]).unwrap();
        stream.feed(&vec![0.0_f32; 200]).unwrap();
        assert_eq!(feeds.load(Ordering::SeqCst), 2);
        assert_eq!(samples.load(Ordering::SeqCst), 300);

        // drain で 2 セグメント取り出す
        let drained = stream.drain_segments();
        assert_eq!(drained.len(), 2);
        assert!(drained.iter().all(|s| s.speaker.as_deref() == Some("自分")));
        assert!(drained
            .iter()
            .all(|s| s.source == Some(TranscriptionSource::Microphone)));

        // 連続 drain は空
        assert!(stream.drain_segments().is_empty());

        // finalize で残りの finalized セグメントが 1 つ返る
        let final_segments = stream.finalize().unwrap();
        assert_eq!(final_segments.len(), 1);
        assert_eq!(final_segments[0].text, "finalized");
    }

    #[test]
    fn test_stream_config_speaker_propagates_to_segments() {
        // start_stream に渡した speaker が、各 stream のセグメントに反映される。
        // マイク (自分) とシステム音声 (相手側) を別ストリームで動かす運用の前提。
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::new(AtomicUsize::new(0)),
            samples_seen: Arc::new(AtomicUsize::new(0)),
        });

        let mut mic = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("自分".to_string()),
                source: Some(TranscriptionSource::Microphone),
                language: None,
            })
            .unwrap();
        let mut sys = Arc::clone(&engine)
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: Some("相手側".to_string()),
                source: Some(TranscriptionSource::SystemAudio),
                language: None,
            })
            .unwrap();

        mic.feed(&[0.0; 10]).unwrap();
        sys.feed(&[0.0; 10]).unwrap();

        let mic_segs = mic.drain_segments();
        let sys_segs = sys.drain_segments();
        assert_eq!(mic_segs[0].speaker.as_deref(), Some("自分"));
        assert_eq!(sys_segs[0].speaker.as_deref(), Some("相手側"));
        assert_eq!(mic_segs[0].source, Some(TranscriptionSource::Microphone));
        assert_eq!(sys_segs[0].source, Some(TranscriptionSource::SystemAudio));
    }

    #[test]
    fn test_feed_empty_samples_is_noop_in_mock() {
        // 空 feed でもエラーにならず、後続の feed が引き続き動くこと
        let feeds = Arc::new(AtomicUsize::new(0));
        let samples = Arc::new(AtomicUsize::new(0));
        let engine: Arc<dyn TranscriptionEngine> = Arc::new(MockEngine {
            feeds_seen: Arc::clone(&feeds),
            samples_seen: Arc::clone(&samples),
        });
        let mut stream = engine
            .start_stream(StreamConfig {
                sample_rate: 16_000,
                speaker: None,
                source: None,
                language: None,
            })
            .unwrap();

        stream.feed(&[]).unwrap();
        stream.feed(&[1.0, 2.0, 3.0]).unwrap();
        // モックは feed 回数を必ずカウントする
        assert_eq!(feeds.load(Ordering::SeqCst), 2);
        assert_eq!(samples.load(Ordering::SeqCst), 3);
    }

    // ─────────────────────────────────────────
    // StreamConfig Debug / Clone セマンティクス テスト
    // ─────────────────────────────────────────

    #[test]
    fn stream_config_debug_output_contains_struct_name_all_four_field_names_with_some_and_none() {
        let config = StreamConfig {
            sample_rate: 44100,
            speaker: Some("自分".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: Some("ja".to_string()),
        };
        let dbg = format!("{:?}", config);
        assert!(
            dbg.contains("StreamConfig"),
            "Debug 出力に型名 StreamConfig が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("sample_rate"),
            "Debug 出力に field 名 sample_rate が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("speaker"),
            "Debug 出力に field 名 speaker が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("source"),
            "Debug 出力に field 名 source が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("language"),
            "Debug 出力に field 名 language が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("44100"),
            "Debug 出力に sample_rate 値 44100 が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("自分"),
            "Debug 出力に speaker 値が含まれる: {dbg}"
        );
        assert!(
            dbg.contains("ja"),
            "Debug 出力に language 値 ja が含まれる: {dbg}"
        );
        assert!(dbg.contains("Some"), "Debug 出力に Some が含まれる: {dbg}");
        assert!(
            dbg.contains("Microphone"),
            "Debug 出力に enum variant 名 Microphone が含まれる: {dbg}"
        );
        let config2 = StreamConfig {
            sample_rate: 0,
            speaker: None,
            source: None,
            language: None,
        };
        let dbg2 = format!("{:?}", config2);
        assert!(
            dbg2.contains("None"),
            "None config の Debug 出力に None が含まれる: {dbg2}"
        );
        assert!(
            dbg2.contains("0"),
            "None config の Debug 出力に sample_rate 値 0 が含まれる: {dbg2}"
        );
    }

    #[test]
    fn stream_config_debug_output_equals_after_clone_for_some_and_none_variants() {
        let c = StreamConfig {
            sample_rate: 48000,
            speaker: Some("相手側".to_string()),
            source: Some(TranscriptionSource::SystemAudio),
            language: Some("en".to_string()),
        };
        assert_eq!(
            format!("{:?}", c),
            format!("{:?}", c.clone()),
            "全 Some config の Debug 出力は clone 後と完全一致する"
        );
        let c2 = StreamConfig {
            sample_rate: 16000,
            speaker: None,
            source: None,
            language: None,
        };
        assert_eq!(
            format!("{:?}", c2),
            format!("{:?}", c2.clone()),
            "全 None config の Debug 出力は clone 後と完全一致する"
        );
    }

    #[test]
    fn stream_config_clone_produces_independent_copy_for_option_string_fields() {
        let original = StreamConfig {
            sample_rate: 22050,
            speaker: Some("orig_speaker".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: Some("ja".to_string()),
        };
        let mut cloned = original.clone();
        cloned.speaker = Some("mutated_speaker".to_string());
        cloned.source = Some(TranscriptionSource::SystemAudio);
        cloned.language = None;
        cloned.sample_rate = 99999;
        assert_eq!(
            original.sample_rate, 22050,
            "original の sample_rate は cloned mutation 後も不変"
        );
        assert_eq!(
            original.speaker.as_deref(),
            Some("orig_speaker"),
            "original の speaker は cloned mutation 後も不変"
        );
        assert_eq!(
            original.source,
            Some(TranscriptionSource::Microphone),
            "original の source は cloned mutation 後も不変"
        );
        assert_eq!(
            original.language.as_deref(),
            Some("ja"),
            "original の language は cloned mutation 後も不変"
        );
        assert_eq!(
            cloned.sample_rate, 99999,
            "cloned の sample_rate は mutation で 99999 に変わる"
        );
        assert_eq!(cloned.speaker.as_deref(), Some("mutated_speaker"));
        assert_eq!(cloned.source, Some(TranscriptionSource::SystemAudio));
        assert!(
            cloned.language.is_none(),
            "cloned の language は None に変わる"
        );
    }
}
