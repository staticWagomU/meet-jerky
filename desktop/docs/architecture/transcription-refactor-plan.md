# transcription.rs 責務分離プラン

## 目的

`src-tauri/src/transcription.rs` (2999 行) はリポジトリで最大級の単一ファイルであり、9 つの責務が混在している。本プランは AGENTS.md 優先順位 1 (クラッシュ修正) への **予防的寄与** (= 巨大ファイルの理解難度を下げ、クラッシュバグ混入リスクを抑制) と、優先順位 4 (リアルタイム文字起こし低遅延化) のための **最適化対象特定容易化** を目標に、段階的な責務分離 (Tidy First / refactoring) を提案する。

## 現状サマリ

- ファイル: `src-tauri/src/transcription.rs`
- 行数: 2999 行 (本プラン作成時点 2026-05-05)
- 責務肥大ホットスポット: Worker loop 領域 (L1110-2999+) が ~1900 行 = ファイル全体の約 63%
- リポジトリ最大ファイル候補: app_detection.rs (3017 行) と並ぶ二大ファイル

## 9 責務マップ

| # | 責務 | 行範囲 (目安) | 規模 | 抽出先候補 | リスク |
|---|------|--------------|------|-----------|--------|
| 1 | データ型 | L15-58 | ~50 | `transcription/types.rs` | 低 |
| 2 | トレイト定義 (`StreamConfig` / `TranscriptionEngine` / `TranscriptionStream`) | L59-106 | ~50 | `transcription/engine.rs` | 低 |
| 3 | Whisper エンジン (`WhisperLocal` + `WhisperStream` + 純粋関数) | L108-405 | ~300 | `transcription/whisper_local.rs` | 中 |
| 4 | Model 管理 (`ModelManager`) | L407-555 | ~150 | `transcription/model_manager.rs` | 中 |
| 5 | Transcription state (`TranscriptionManager` + `TranscriptionStateHandle`) | L556-687 | ~130 | `transcription/manager.rs` | 中 |
| 6 | Audio resampling (`sinc_params` / `resample_audio`) | L932-1029 | ~100 | 既存 `audio_utils.rs` 統合 | 低 |
| 7 | Tauri commands (`list_models` / `is_model_downloaded` / `start_transcription` / `stop_transcription` 等) | L688-931 | ~250 | `transcription/commands.rs` | 中 |
| 8 | Worker loop (run_transcription_loop / panic_guard / emit_segments / 各種 helper) | L1110-2999+ | ~1900 | `transcription/worker.rs` (更にサブ分割推奨) | **高** |
| 9 | Helper (validate_stream_count / parse_requested_sources / error payload builders 等) | L741-1109 | ~370 | 各責務の private モジュール | 中 |

## 進捗サマリ (mjc-main-20260505-18 Loop 35 + 36 時点)

- **Phase 1 (責務 1-2 = データ型 + トレイト)**: ✅ 完了 (mjc-main-20260505-3)
- **Phase 2-A (責務 3 = Whisper エンジン)**: ✅ 完了 (mjc-main-20260505-4 ~ 7)
- **Phase 2-B (責務 4 = Model 管理)**: ✅ 完了 (mjc-main-20260505-5)
- **Phase 2 残り (責務 6 = Audio resampling)**: ✅ 完了 (mjc-main-20260505-6)
- **Phase 3 (責務 5 = Transcription state)**: ✅ 完了 (mjc-main-20260505-8)
- **Phase 3-B (責務 7 = Tauri commands)**: ✅ **完全完了** (mjc-main-20260505-11 ~ 14, Loop 21 ~ 28)
  - build_download_*_payload helper / list_models / is_model_downloaded / download_model /
    validate_stream_count_for_engine / parse_requested_transcription_sources /
    RequestedTranscriptionSources struct / TRANSCRIPTION_SOURCE_* const / 17 tests /
    stop_transcription / start_transcription / PendingTranscriptionStream
    すべて transcription_commands.rs に集約
- **Phase 4 (責務 8 = Worker loop)**: ✅ 完了 (mjc-main-20260505-8 ~ 10, Phase 4-A emission + 4-B error_payload + 4-C panic_guard + 4-D run_transcription_loop)
- **transcription.rs 累計削減**: 元 2999 行 → 現在 **1175 行** = **約 60.8% 縮小** (~1824 行削減) = **「60% 里程標突破」**

## 残存課題 (Phase 5 候補)

- **mjc-main-20260505-16 Loop 32 ✅ 完了**: resample_audio テスト 4 件を audio_utils.rs に移動 (commit `192faae`、-44 行)
- **mjc-main-20260505-17 Loop 33 ✅ 完了**: TranscriptionLoopConfig struct を transcription_worker_loop.rs に移動 (互換 re-export pattern、commit `5a5c814`、-6 行)
- **mjc-main-20260505-18 Loop 35 ✅ 完了**: transcription_error_payload 関連テスト 15 件 (ブロック A 4 件 + ブロック B 11 件) を transcription_error_payload.rs に移動 (commit `dde8175`、-311 行)
- transcription.rs 残存 **1175 行** の更なる責務分離 (Worker loop 内部 helper / responses processing / Whisper 関連 helper)
- 候補: TranscriptionStateHandle / WhisperStream の locality 改善、テスト移動続編 (`calculate_rms` / `is_tail_silent` 系)、TranscriptionSegment テスト移動、WhisperStream テスト移動
- 規模 M-L、複数ループ計画推奨
- 各 Phase 着手時は最新の transcription.rs を read して、本プランの行範囲とずれていないか確認する

## 推奨段階分割 (Phase)

### Phase 1: 安全な低リスク抽出 (最初に着手)

**目的**: 純粋データ型・トレイトを切り出してファイル肥大を ~100 行削減。振る舞い完全不変。

1. **責務 1 (データ型)** を `transcription/types.rs` に抽出
   - 抽出対象: `TranscriptionSource`, `TranscriptionSegment`, `TranscriptionErrorPayload`, `ModelInfo`
   - 影響範囲: 他モジュール (`lib.rs` / `audio.rs` / `session_manager.rs` 等) の `use transcription::TranscriptionSource` 等
   - リスク: 低 (純粋データ型、振る舞い不変)
   - 互換層: 移行期間中は `transcription.rs` 内で `pub use types::*;` を再エクスポート
   - 工数: 1 ループ
2. **責務 2 (トレイト定義)** を `transcription/engine.rs` に抽出
   - 抽出対象: `StreamConfig`, `TranscriptionEngine`, `TranscriptionStream`
   - 影響範囲: trait impl ブロック (Phase 2 で抽出予定の Whisper エンジンと連携)
   - リスク: 低
   - 工数: 1 ループ

### Phase 2: 中規模抽出 (Phase 1 完了後)

3. **責務 3 (Whisper エンジン)** を `transcription/whisper_local.rs` に抽出
   - 抽出対象: `WhisperLocal`, `WhisperStream`, `calculate_rms`, `is_tail_silent`
   - 影響範囲: `ModelManager` 経由参照、`commands.rs`
   - リスク: 中 (純粋関数 + impl の境界判断、Whisper 依存の use 文整理)
   - 工数: 1-2 ループ
4. **責務 4 (Model 管理)** を `transcription/model_manager.rs` に抽出
   - 抽出対象: `ModelManager` + impl
   - 影響範囲: `TranscriptionManager` から委譲
   - リスク: 中
   - 工数: 1-2 ループ
5. **責務 6 (Audio resampling)** を既存 `audio_utils.rs` に統合
   - 抽出対象: `sinc_params`, `resample_audio`
   - 影響範囲: `WhisperStream` のみ
   - リスク: 低 (統合先が既存)
   - 工数: 1 ループ

### Phase 3: 大規模抽出 (Phase 1-2 完了後)

6. **責務 5 (Transcription state)** を `transcription/manager.rs` に抽出
   - 抽出対象: `TranscriptionManager`, `TranscriptionStateHandle`, `build_download_*_payload`
   - 影響範囲: lib.rs (Tauri state 登録)、commands.rs
   - リスク: 中-高 (Mutex 経由 state を複数モジュールで参照)
   - 工数: 2-3 ループ
7. **責務 7 (Tauri commands)** を `transcription/commands.rs` に抽出
   - 抽出対象: `list_models`, `is_model_downloaded`, `validate_stream_count_for_engine`, `start_transcription`, `stop_transcription`
   - 影響範囲: lib.rs の `tauri::Builder::invoke_handler` 登録
   - リスク: 中
   - 工数: 2-3 ループ

### Phase 4: 最大ホットスポット (最後に着手)

8. **責務 8 (Worker loop)** を `transcription/worker.rs` に抽出 + 更にサブ分割
   - 抽出対象 (~1900 行):
     - 構造体: `PendingTranscriptionStream`, `RequestedTranscriptionSources`, `TranscriptionLoopConfig`
     - エラー: `build_transcription_error_payload`, `build_worker_panic_error_payload`, `transcription_error_payload_to_value`, `is_realtime_stream_already_stopped_error`, `should_emit_realtime_stream_error`
     - panic guard: `run_transcription_worker_with_panic_guard`
     - メイン loop: `run_transcription_loop`
     - emission: `emit_segments` 系
   - サブ分割推奨: `transcription/worker/{loop, error_payload, panic_guard, emission}.rs`
   - 影響範囲: lib.rs / audio.rs / session_manager.rs (event emission 経路)
   - リスク: **高** (worker 内部の thread / channel / tauri::State 連携が複雑、レースコンディション混入リスク)
   - 工数: 3-5 ループ (各ループ TDD red→green、cargo test --lib 件数不変が必須指標)

## 検証戦略

各 Phase / 各ループで以下を必ず実行:

- `cargo test --lib`: 全件 pass を維持 (現 667 件、抽出ごとに件数不変が指標)
- `cargo clippy --lib -- -D warnings`: 警告ゼロを維持
- `cargo fmt --check`: 整形維持
- `npm run build`: tsc + vite build (frontend 触れない場合も整合性確認)

**構造改善のみで振る舞い不変なので、各ループでの TDD は通常不要** (= 既存 667 件のテストが migration の一貫性を保証する)。新規テストは抽出先モジュール単独テストや、責務境界明示のための contract test に限定する。

## リスク管理

1. **抽出時の use 文混乱**: 移行期間中は `pub use types::*;` 等の互換層 (re-export) を `transcription.rs` 側に残し、import 元を変更不要にする。Phase 完了後にまとめて整理。
2. **pub fn シグネチャの不変性**: lib.rs / commands.rs 側変更を最小限にするため、抽出後も既存シグネチャを維持。
3. **大規模 worker (責務 8) は最後**: 影響範囲が最も広く、レースコンディション混入リスクが高いため、Phase 1-3 が完了して責務マップが安定した時点で着手する。
4. **1 ループ 1 抽出原則**: 単一抽出ごとに commit + cargo test pass を確認。バックトラックを最小化する。

## AGENTS.md 優先順位との対応

| AGENTS.md 優先順位 | 本プランの寄与 |
|------|--------------|
| 1. クラッシュ修正 | 巨大ファイルの理解性向上 → クラッシュバグ混入リスク予防 (予防的寄与) |
| 4. リアルタイム文字起こし低遅延化 | Worker loop (責務 8) の責務分離 → 最適化対象の特定容易化 |
| 5. 文字起こし精度等 | Whisper エンジン (責務 3) / Model 管理 (責務 4) の独立化 → 個別最適化容易化 |

## 関連: app_detection.rs の Webex モジュール抽出 ✅ 完了 (mjc-main-20260505-15 Loop 29 = commit b4a0098)

本プランは transcription.rs 専用だが、同様の責務肥大は `app_detection.rs` (3356 行) の Webex 検知関数群 (`is_webex_host` / `is_webex_meeting_url` / `is_jphp_path` / `is_webex_jphp_meeting_url` / `is_wbxmjs_path` / `is_webex_wbxmjs_meeting_url` / `is_webappng_path` / `is_webex_webappng_meeting_url` の 8 関数) にも存在していた。

mjc-main-20260505-2 で Webex 招待 URL 主要 4 系統 (Personal Room / j.php / wbxmjs / webappng) の網羅が完了したのち、mjc-main-20260505-15 Loop 29 (commit `b4a0098`) で 8 関数を `src-tauri/src/app_detection_webex.rs` に集約した。

- 関数 8 つを pub(crate) で移動
- ヘルパー (`is_valid_dns_label` / `has_single_non_empty_segment` / `query_has_non_empty_param`) は他サービス (Whereby / GoToMeeting / Google Meet / Zoom) でも使用のため app_detection.rs に残置 + pub(crate) 化
- tests は classify_meeting_url 経由のため app_detection.rs 残置
- 振る舞い不変 = 700 passed 件数不変

同パターン (サービス別関数の独立モジュール化) は Whereby が Loop 31、GoToMeeting が Loop 36 で完了済み。残るは Zoom / Microsoft Teams (今後の Tidy First 候補だが、app_detection.rs サービス別抽出 sweep 化リスクあり = Webex (29) + Whereby (31) + GoToMeeting (36) で 3/7 ループ間隔、4 件目連続は sweep 警告超過 = 次回再訪は Loop 39+ 推奨)。

### app_detection_whereby.rs ✅ 完了 (mjc-main-20260505-16 Loop 31 = commit `a523edd`)

mjc-main-20260505-16 Loop 31 で Whereby 検知関数群を `src-tauri/src/app_detection_whereby.rs` に集約した。

- 関数 2 つ (`is_whereby_host` / `is_whereby_meeting_url`) を `pub(crate)` で移動
- 24 要素の const (`WHEREBY_NON_ROOM_PATHS`) は Whereby 専用のため private 維持
- ヘルパー `is_valid_dns_label` は Loop 29 (Webex 抽出) で `pub(crate)` 化済 = 追加変更不要
- tests は classify_meeting_url 経由のため app_detection.rs 残置 = Loop 23 / Loop 29 precedent 踏襲
- 振る舞い不変 = 700 passed 件数不変

### app_detection_goto.rs ✅ 完了 (mjc-main-20260505-18 Loop 36 = commit `1904e04`)

mjc-main-20260505-18 Loop 36 で GoToMeeting 検知関数群を `src-tauri/src/app_detection_goto.rs` に集約した。

- 関数 4 つ (`is_goto_host` / `is_goto_meeting_url` / `is_goto_legacy_meeting_url` / `is_goto_app_meeting_url`) を `pub(crate)` で移動
- const `GOTO_NON_ROOM_PATHS` を GoToMeeting 専用のため新ファイルに集約
- ヘルパー `is_valid_dns_label` は Loop 29 (Webex 抽出) で `pub(crate)` 化済 = `use crate::app_detection::is_valid_dns_label` で取り込み
- caller (`classify_meeting_url` 内の 3 関数 OR 連結) は `crate::app_detection_goto::is_goto_*` 経由に更新
- tests は classify_meeting_url 経由テストは app_detection.rs 残置、直接呼びテストは use 文経由参照に更新
- lib.rs に `mod app_detection_goto` 宣言追加
- 振る舞い不変 = 700 passed 件数不変
- app_detection.rs 3231 → 3184 行 (-47 行)、app_detection_goto.rs 0 → 49 行 (新規)

## 関連: TranscriptionLoopConfig struct 移動 ✅ 完了 (mjc-main-20260505-17 Loop 33 = commit `5a5c814`)

mjc-main-20260505-17 Loop 33 で `TranscriptionLoopConfig` struct を transcription.rs から `src-tauri/src/transcription_worker_loop.rs` に移動した。

- 責務的妥当性: struct は `run_transcription_loop` 関数の入力 = 同一ファイルに置くのが locality 最大
- 互換 re-export pattern (`pub(crate) use crate::transcription_worker_loop::TranscriptionLoopConfig;`) を transcription.rs L56 に追加
- 3 caller (`transcription_panic_guard.rs` / `transcription_commands.rs`) の `use crate::transcription::TranscriptionLoopConfig;` は変更不要 = 互換層経由で動作
- transcription_worker_loop.rs L7 の `use crate::transcription::TranscriptionLoopConfig;` は self-reference になるため削除
- transcription.rs の `use std::sync::atomic::AtomicBool;` / `use std::sync::Arc;` は struct 削除後 unused になるため削除 (cargo clippy --lib --tests で検証)
- 振る舞い不変 = 700 passed 件数不変
- transcription.rs 1492 → 1486 行 (-6 行)、transcription_worker_loop.rs +16 行

## 関連: transcription_error_payload tests 移動 ✅ 完了 (mjc-main-20260505-18 Loop 35 = commit `dde8175`)

mjc-main-20260505-18 Loop 35 で transcription_error_payload 関連テスト 15 件 (~290 行) を transcription.rs から `src-tauri/src/transcription_error_payload.rs` に移動した。

- ブロック A 4 件 (transcription.rs L120-180): worker_panic_payload 系 + transcription_error_payload_serialization 系 + stopped_realtime_stream_errors_are_not_emitted_to_ui
- ブロック B 11 件 (transcription.rs L600-847): build_worker_panic_error_payload_omits_source_when_none / build_transcription_error_payload_preserves_empty_error_string / is_realtime_stream_already_stopped_error_* 3 件 / build_*_serialization_with_*_source 系 + escapes_newlines / debug_output 系 + partial_eq
- 移動先には `mod tests` 新設 + `use super::*` + `use crate::transcription_types::{TranscriptionErrorPayload, TranscriptionSource}` を取り込み
- 規模 S 一括 (Loop 25 17 件 ~322 行 precedent と同等規模で批判判断 = 一括移動採用)
- 振る舞い不変 = 700 passed 件数不変、clippy 警告ゼロ、fmt OK
- transcription.rs 1486 → 1175 行 (-311 行) = **60% 里程標突破**、transcription_error_payload.rs 29 → 343 行 (+314 行)

## 参考

- 本プランは mjc-main-20260505-3 (Loop 4) で grep ベース構造分析により作成。
- 実コードは生きており、Phase 着手時に再度行範囲・責務分類の妥当性を検証する必要がある。
- 各 Phase 着手時は必ず最新の `transcription.rs` を read して、本プランの行範囲とずれていないか確認する。
- (本プラン作成時の 2999 行は mjc-main-20260505-3 時点。mjc-main-20260505-18 Loop 35 + 36 時点で 1175 行 = 約 60.8% 縮小達成 = 60% 里程標突破)
