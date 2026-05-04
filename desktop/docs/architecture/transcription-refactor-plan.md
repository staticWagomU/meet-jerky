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

## 関連: app_detection.rs の Webex モジュール抽出 (将来課題)

本プランは transcription.rs 専用だが、同様の責務肥大は `app_detection.rs` (3017 行) の Webex 検知関数群 (`is_webex_host` / `is_webex_meeting_url` / `is_jphp_path` / `is_webex_jphp_meeting_url` / `is_wbxmjs_path` / `is_webex_wbxmjs_meeting_url` / `is_webappng_path` / `is_webex_webappng_meeting_url` の 8 関数) にも存在する。

mjc-main-20260505-2 で Webex 招待 URL 主要 4 系統 (Personal Room / j.php / wbxmjs / webappng) の網羅が完了したため、Webex 関数群を `app_detection/webex.rs` に抽出する Tidy First 候補が将来発生する。本プランの Phase 1 完了後 (transcription.rs 側で抽出パターンを確立した後)、同パターンを app_detection.rs に応用する道筋を取る。

## 参考

- 本プランは mjc-main-20260505-3 (Loop 4) で grep ベース構造分析により作成。
- 実コードは生きており、Phase 着手時に再度行範囲・責務分類の妥当性を検証する必要がある。
- 各 Phase 着手時は必ず最新の `transcription.rs` を read して、本プランの行範囲とずれていないか確認する。
