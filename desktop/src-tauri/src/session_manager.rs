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
        match self.current.lock() {
            Ok(guard) => guard,
            Err(err) => {
                eprintln!("[session_manager] mutex poisoned; recovering active session state");
                err.into_inner()
            }
        }
    }

    /// in-memory のみでセッションを開始する。ディスク書き出しは行わない。
    #[cfg(test)]
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

    #[cfg(test)]
    pub fn is_active(&self) -> bool {
        self.lock().is_some()
    }

    #[cfg(test)]
    pub fn current_title(&self) -> Option<String> {
        self.lock().as_ref().map(|a| a.session.title.clone())
    }

    #[cfg(test)]
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
        if let Err(err) =
            session_store::write_session_markdown_to(&output.path, &active.session, output.offset)
        {
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
        assert_eq!(files.len(), 1, "exactly one .md should exist: {files:?}");

        let contents = std::fs::read_to_string(&files[0]).unwrap();
        assert!(
            contents.contains("**[14:50:15] 自分:** hello"),
            "segment line missing after append. contents=\n{contents}"
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
        manager
            .append("相手側".into(), 12, "二言目".into())
            .unwrap();

        let files = list_md_files(dir.path());
        assert_eq!(files.len(), 1);
        let contents = std::fs::read_to_string(&files[0]).unwrap();

        assert!(
            contents.contains("**[14:50:05] 自分:** 一言目"),
            "first segment lost. contents=\n{contents}"
        );
        assert!(
            contents.contains("**[14:50:12] 相手側:** 二言目"),
            "second segment missing. contents=\n{contents}"
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
        manager
            .append("相手側".into(), 12, "二言目".into())
            .unwrap();

        let files_before = list_md_files(dir.path());
        assert_eq!(files_before.len(), 1);
        let path = files_before[0].clone();
        let before = std::fs::read_to_string(&path).unwrap();

        let session = manager.finalize(1_713_333_100).expect("finalize");
        let after = std::fs::read_to_string(&path).unwrap();

        // 全セグメントがディスクに残っている
        assert!(after.contains("**[14:50:05] 自分:** 一言目"));
        assert!(after.contains("**[14:50:12] 相手側:** 二言目"));
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

        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");

        assert!(manager.is_active());
    }

    #[test]
    fn finalize_clears_state_and_subsequent_finalize_errors() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        let session = manager.finalize(200).expect("finalize should succeed");

        assert_eq!(session.title, "meeting");
        assert_eq!(session.ended_at, Some(200));
        assert_eq!(session.segments.len(), 1);
        assert!(!manager.is_active());

        let err = manager
            .finalize(300)
            .expect_err("second finalize should fail");
        assert_eq!(err, SessionManagerError::NotActive);
    }

    #[test]
    fn discard_clears_active_session_without_finalizing() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        manager.discard().expect("discard should succeed");

        assert!(!manager.is_active());
        let err = manager
            .finalize(200)
            .expect_err("finalize after discard should fail");
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

        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed after start");

        assert_eq!(manager.current_segment_count(), Some(1));
    }

    #[test]
    fn start_twice_returns_already_active_and_retains_first_session() {
        let manager = SessionManager::new();
        manager
            .start("first".into(), 100)
            .expect("first start should succeed");

        let err = manager
            .start("second".into(), 200)
            .expect_err("second start should fail");

        assert_eq!(err, SessionManagerError::AlreadyActive);
        assert_eq!(manager.current_title(), Some("first".into()));
    }

    #[test]
    fn is_active_recovers_from_poisoned_mutex_without_panic() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");

        let poison_result = std::panic::catch_unwind(|| {
            let _guard = manager.current.lock().unwrap();
            panic!("poison session manager mutex");
        });
        assert!(poison_result.is_err());

        assert!(manager.is_active());
        assert_eq!(manager.current_title(), Some("meeting".into()));
    }

    #[test]
    fn append_recovers_from_poisoned_mutex_without_panic() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");

        let poison_result = std::panic::catch_unwind(|| {
            let _guard = manager.current.lock().unwrap();
            panic!("poison session manager mutex");
        });
        assert!(poison_result.is_err());

        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should recover and succeed");

        assert_eq!(manager.current_segment_count(), Some(1));
    }

    #[test]
    fn append_keeps_segment_in_memory_when_output_dir_does_not_exist() {
        let manager = SessionManager::new();
        let tmp = tempdir().unwrap();
        let missing_dir = tmp.path().join("not-exists");
        manager
            .start_with_output("test".to_string(), 1700000000, missing_dir, jst())
            .expect("start should succeed even when output_dir does not exist");

        manager
            .append("user".to_string(), 5, "hello".to_string())
            .expect("append should not propagate disk error");

        assert_eq!(manager.current_segment_count(), Some(1));
        assert!(manager.is_active());
    }

    #[test]
    fn finalize_returns_session_when_output_dir_does_not_exist() {
        let manager = SessionManager::new();
        let tmp = tempdir().unwrap();
        let missing_dir = tmp.path().join("not-exists");
        manager
            .start_with_output("test".to_string(), 1700000000, missing_dir, jst())
            .expect("start should succeed");
        manager
            .append("user".to_string(), 5, "hello".to_string())
            .expect("append should not propagate disk error");

        let session = manager
            .finalize(1700000060)
            .expect("finalize should succeed even with persist error");

        assert_eq!(session.title, "test");
        assert_eq!(session.segments.len(), 1);
        assert!(!manager.is_active());
    }

    #[test]
    fn start_with_output_returns_already_active_when_started_via_basic_start() {
        let manager = SessionManager::new();
        let tmp = tempdir().unwrap();
        manager
            .start("title-A".into(), 1700000000)
            .expect("first start should succeed");

        let err = manager
            .start_with_output(
                "title-B".into(),
                1700000010,
                tmp.path().to_path_buf(),
                jst(),
            )
            .expect_err("start_with_output while already active should fail");

        assert_eq!(err, SessionManagerError::AlreadyActive);
        assert!(manager.is_active());
        assert_eq!(
            manager.current_title(),
            Some("title-A".into()),
            "元のタイトルが保たれる"
        );
        assert_eq!(
            manager.current_started_at_secs(),
            Some(1700000000),
            "元の started_at が保たれる"
        );
    }

    #[test]
    fn start_returns_already_active_when_started_via_start_with_output() {
        let manager = SessionManager::new();
        let tmp = tempdir().unwrap();
        manager
            .start_with_output(
                "title-A".into(),
                1700000000,
                tmp.path().to_path_buf(),
                jst(),
            )
            .expect("first start_with_output should succeed");

        let err = manager
            .start("title-B".into(), 1700000010)
            .expect_err("start while already active should fail");

        assert_eq!(err, SessionManagerError::AlreadyActive);
        assert!(manager.is_active());
        assert_eq!(
            manager.current_title(),
            Some("title-A".into()),
            "元のタイトルが保たれる"
        );
        assert_eq!(
            manager.current_started_at_secs(),
            Some(1700000000),
            "元の started_at が保たれる"
        );
    }

    #[test]
    fn discard_clears_session_started_with_output_and_subsequent_append_returns_not_active() {
        let manager = SessionManager::new();
        let tmp = tempdir().unwrap();
        manager
            .start_with_output("title".into(), 1700000000, tmp.path().to_path_buf(), jst())
            .expect("start_with_output should succeed");

        manager.discard().expect("discard should succeed");

        let err = manager
            .append("speaker".into(), 0, "text".into())
            .expect_err("append after discard should fail");

        assert_eq!(err, SessionManagerError::NotActive);
        assert!(!manager.is_active());
        assert!(
            list_md_files(tmp.path()).is_empty(),
            "discard はファイルを書かずに sweep する契約"
        );
    }

    #[test]
    fn persist_if_configured_is_no_op_when_output_is_none() {
        let dir = tempdir().unwrap();
        let active = ActiveSession {
            session: Session::start("title".into(), 1_700_000_000),
            output: None,
        };

        persist_if_configured(&active, "append");

        let files = list_md_files(dir.path());
        assert!(
            files.is_empty(),
            "output=None なら disk 副作用ゼロのはず: files={files:?}"
        );
        assert_eq!(active.session.segments.len(), 0);
        assert_eq!(active.session.started_at, 1_700_000_000);
        assert_eq!(active.session.title, "title");
    }

    #[test]
    fn persist_if_configured_writes_markdown_when_output_is_some() {
        let dir = tempdir().unwrap();
        let mut session = Session::start("会議メモ".into(), 1_713_333_000);
        session.append_segment("自分".into(), 15, "hello".into());
        let path = crate::session_store::path_for_session(dir.path(), &session);
        let active = ActiveSession {
            session,
            output: Some(ActiveOutput {
                path: path.clone(),
                offset: jst(),
            }),
        };

        persist_if_configured(&active, "append");

        assert!(
            path.exists(),
            "direct persist で .md が作成されるはず: {path:?}"
        );
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(
            contents.contains("会議メモ"),
            "session の title が markdown 本文に含まれるはず. contents=\n{contents}"
        );
        assert!(
            contents.contains("**[14:50:15] 自分:** hello"),
            "append された segment 行が含まれるはず. contents=\n{contents}"
        );
    }

    #[test]
    fn persist_if_configured_does_not_panic_when_path_parent_is_missing() {
        let dir = tempdir().unwrap();
        let missing_parent = dir.path().join("not-exists-yet");
        let invalid_path = missing_parent.join("session.md");
        let active = ActiveSession {
            session: Session::start("title".into(), 1_700_000_000),
            output: Some(ActiveOutput {
                path: invalid_path.clone(),
                offset: jst(),
            }),
        };

        persist_if_configured(&active, "finalize");

        assert!(
            !invalid_path.exists(),
            "親ディレクトリ無しなら write は失敗、ファイルは作成されないはず: {invalid_path:?}"
        );
        assert_eq!(active.session.segments.len(), 0);
        assert_eq!(active.session.title, "title");
    }

    #[test]
    fn persist_if_configured_is_idempotent_when_called_repeatedly() {
        let dir = tempdir().unwrap();
        let mut session = Session::start("idempotent".into(), 1_713_333_000);
        session.append_segment("Alice".into(), 10, "first".into());
        let path = crate::session_store::path_for_session(dir.path(), &session);
        let active = ActiveSession {
            session,
            output: Some(ActiveOutput {
                path: path.clone(),
                offset: jst(),
            }),
        };

        persist_if_configured(&active, "append");
        let contents_first =
            std::fs::read_to_string(&path).expect("first persist should write file");

        persist_if_configured(&active, "append");
        let contents_second =
            std::fs::read_to_string(&path).expect("second persist should keep file");

        assert_eq!(
            contents_first, contents_second,
            "同じ active を 2 回 persist しても disk content は同一 (overwrite idempotency) のはず"
        );
        let files = list_md_files(dir.path());
        assert_eq!(
            files.len(),
            1,
            "2 回 persist しても .md ファイルは 1 件のはず: {files:?}"
        );
    }

    #[test]
    fn persist_if_configured_accepts_arbitrary_phase_label_without_panic() {
        let dir = tempdir().unwrap();
        let mut session = Session::start("phase-label".into(), 1_713_333_000);
        session.append_segment("Bob".into(), 0, "msg".into());
        let path = crate::session_store::path_for_session(dir.path(), &session);
        let active = ActiveSession {
            session,
            output: Some(ActiveOutput {
                path: path.clone(),
                offset: jst(),
            }),
        };

        for phase in [
            "append",
            "finalize",
            "",
            "🔥",
            "改行\nincluded",
            "phase=test",
        ] {
            persist_if_configured(&active, phase);
        }

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(
            !contents.contains("🔥"),
            "phase ラベルは disk content には漏れないはず. contents=\n{contents}"
        );
        assert!(
            !contents.contains("phase=test"),
            "phase ラベルは disk content には漏れないはず. contents=\n{contents}"
        );
        assert!(
            contents.contains("phase-label"),
            "session の title は依然 disk content に含まれるはず. contents=\n{contents}"
        );
    }

    #[test]
    fn discard_twice_returns_not_active_on_second_call() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");

        manager.discard().expect("first discard should succeed");

        let err = manager
            .discard()
            .expect_err("second discard should fail with NotActive");
        assert_eq!(err, SessionManagerError::NotActive);
        assert!(!manager.is_active(), "2 回目以降も非活性を維持");
    }

    #[test]
    fn discard_clears_all_accessors_to_none() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 1_700_000_000)
            .expect("start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        assert!(manager.is_active());
        assert_eq!(manager.current_title(), Some("meeting".into()));
        assert_eq!(manager.current_started_at_secs(), Some(1_700_000_000));
        assert_eq!(manager.current_segment_count(), Some(1));

        manager.discard().expect("discard should succeed");

        assert!(!manager.is_active());
        assert_eq!(
            manager.current_title(),
            None,
            "discard 後 title=None を維持する契約"
        );
        assert_eq!(
            manager.current_started_at_secs(),
            None,
            "discard 後 started_at_secs=None を維持する契約"
        );
        assert_eq!(
            manager.current_segment_count(),
            None,
            "discard 後 segment_count=None を維持する契約"
        );
    }

    #[test]
    fn discard_recovers_from_poisoned_mutex_without_panic() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 100)
            .expect("start should succeed");

        let poison_result = std::panic::catch_unwind(|| {
            let _guard = manager.current.lock().unwrap();
            panic!("poison session manager mutex");
        });
        assert!(poison_result.is_err());

        manager
            .discard()
            .expect("discard should recover from poisoned mutex and succeed");

        assert!(!manager.is_active());
        let err = manager
            .discard()
            .expect_err("second discard after recover should be NotActive");
        assert_eq!(err, SessionManagerError::NotActive);
    }

    #[test]
    fn discard_does_not_remove_already_persisted_disk_file_when_appended() {
        let manager = SessionManager::new();
        let dir = tempdir().unwrap();
        manager
            .start_with_output(
                "title".into(),
                1_700_000_000,
                dir.path().to_path_buf(),
                jst(),
            )
            .expect("start_with_output should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");

        let files_before = list_md_files(dir.path());
        assert_eq!(
            files_before.len(),
            1,
            "append 後に disk file が 1 件存在しているはず: {files_before:?}"
        );
        let path_before = files_before[0].clone();
        let contents_before = std::fs::read_to_string(&path_before).unwrap();

        manager.discard().expect("discard should succeed");

        assert!(!manager.is_active());
        let files_after = list_md_files(dir.path());
        assert_eq!(
            files_after.len(),
            1,
            "discard 後も disk file は 1 件残るはず (ステルス削除しない契約): {files_after:?}"
        );
        assert_eq!(
            files_after[0], path_before,
            "discard 後も同じ path のファイルが残るはず"
        );
        let contents_after = std::fs::read_to_string(&files_after[0]).unwrap();
        assert_eq!(
            contents_after, contents_before,
            "discard はディスク内容を改変しない契約"
        );
    }

    #[test]
    fn discard_allows_restart_with_same_title_and_started_at() {
        let manager = SessionManager::new();
        manager
            .start("meeting".into(), 1_700_000_000)
            .expect("first start should succeed");
        manager
            .append("Alice".into(), 5, "hello".into())
            .expect("append should succeed");
        assert_eq!(manager.current_segment_count(), Some(1));

        manager.discard().expect("discard should succeed");

        manager
            .start("meeting".into(), 1_700_000_000)
            .expect("restart with same title and started_at after discard should succeed");

        assert!(manager.is_active());
        assert_eq!(manager.current_title(), Some("meeting".into()));
        assert_eq!(manager.current_started_at_secs(), Some(1_700_000_000));
        assert_eq!(
            manager.current_segment_count(),
            Some(0),
            "discard 後の再 start は新 session のため segments=0 のはず"
        );
    }
}
