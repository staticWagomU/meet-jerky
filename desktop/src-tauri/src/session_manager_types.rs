use crate::session::Session;
use chrono::FixedOffset;
use std::path::PathBuf;

/// 活性セッションの状態。
///
/// `output` が `Some` の場合、`append`/`finalize` ごとに対応ファイルへ全文書き出しを行う
/// （インクリメンタル書き出し）。`None` の場合は in-memory のみで動作する。
pub(crate) struct ActiveSession {
    pub(crate) session: Session,
    pub(crate) output: Option<ActiveOutput>,
}

pub(crate) struct ActiveOutput {
    pub(crate) path: PathBuf,
    pub(crate) offset: FixedOffset,
}
