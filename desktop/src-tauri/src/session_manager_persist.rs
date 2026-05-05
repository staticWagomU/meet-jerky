//! Session の persist 専門 module。
//!
//! `persist_if_configured` は append / finalize 等の phase で session manager から呼び出され、
//! ディスク書き出しエラーは in-memory の一貫性を壊さないようログに留めて無視する。

use crate::session_manager_types::ActiveSession;
use crate::session_store;

/// ディスク書き出しエラーは in-memory の一貫性を壊さないよう、ログに留めて無視する。
/// Phase 5 時点では tracing 未導入のため eprintln で暫定対応。
/// `phase` は append/finalize などの呼び出し文脈をログに残すためのラベル。
pub(crate) fn persist_if_configured(active: &ActiveSession, phase: &str) {
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
