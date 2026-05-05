use std::path::PathBuf;

use serde::Serialize;

/// 保存済みセッションの一覧用メタデータ。
///
/// ファイル本体を必要以上に読まず、UI が一覧表示・検索するために必要な情報を提供する。
/// - `started_at_secs` はファイル名先頭（`<started_at>-<seq>.md`）から復元。
/// - `title` はファイル先頭行 `# ...` の `# ` を除いた残り全体（日付を含む）。
///   日付を分離しない方針: 呼び出し側が素のヘッダ文字列をそのまま見せれば十分。
/// - `search_text` は本文検索用。表示はせず、巨大ファイルで UI を重くしないため先頭だけ読む。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: PathBuf,
    pub started_at_secs: u64,
    pub title: String,
    pub search_text: String,
}
