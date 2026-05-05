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

## 進捗サマリ (mjc-main-20260505-31 Loop 63 時点 = Phase 6 完全終了 = 100% 達成)

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
- **transcription.rs 累計削減**: 元 2999 行 → **ファイル削除完了** = **100% 達成** (~2999 行削減) = **「95% / 98% / 99% / 100% 里程標完全制覇 = Phase 6 完全終了 = transcription.rs ファイル自体を削除 (lib.rs から `mod transcription;` 宣言も削除) = リファクタプラン完全完遂」**

## 残存課題 (Phase 5 候補)

- **mjc-main-20260505-16 Loop 32 ✅ 完了**: resample_audio テスト 4 件を audio_utils.rs に移動 (commit `192faae`、-44 行)
- **mjc-main-20260505-17 Loop 33 ✅ 完了**: TranscriptionLoopConfig struct を transcription_worker_loop.rs に移動 (互換 re-export pattern、commit `5a5c814`、-6 行)
- **mjc-main-20260505-18 Loop 35 ✅ 完了**: transcription_error_payload 関連テスト 15 件 (ブロック A 4 件 + ブロック B 11 件) を transcription_error_payload.rs に移動 (commit `dde8175`、-311 行)
- **mjc-main-20260505-19 Loop 38 ✅ 完了**: transcription_types 関連テスト 10 件 (TranscriptionSegment 4 + TranscriptionSource 3 + ModelInfo 3) を transcription_types.rs に移動 (commit `64fe9cd`、-426 行 = 75% 里程標突破)
- **mjc-main-20260505-21 Loop 42 ✅ 完了**: 沈黙検知テスト 6 件 (calculate_rms 3 + is_tail_silent 3) を audio_utils.rs に移動 (commit `5456409`、-61 行)
- **mjc-main-20260505-22 Loop 44 ✅ 完了**: 沈黙検知定数 3 件 (MIN_FLUSH_SAMPLES / SILENCE_LOOKBACK_SAMPLES / SILENCE_THRESHOLD_RMS) を audio_utils.rs に移動 = 関数 (Loop 32) + テスト (Loop 42) + 定数 (Loop 44) の三位一体 locality 完成 (commit `52098b6`、-10 行)
- **mjc-main-20260505-22 Loop 45 ✅ 完了**: WhisperStream テスト 2 件 (test_whisper_stream_feed_errors_when_resampler_state_missing / test_whisper_stream_finalize_errors_when_resampler_state_missing) + helper (stream_with_missing_resampler) を transcription_whisper_stream.rs に移動 (commit `2a7190b`、-29 行)
- **mjc-main-20260505-23 Loop 47 ✅ 完了**: ModelManager 関連テスト 4 件 (test_list_available_models_not_empty / test_list_available_models_includes_small / test_model_manager_get_path / test_model_not_downloaded_initially) を transcription_model_manager.rs に移動 = ModelManager の locality 完成 (関数本体 + テスト同居) (commit `9e0a66b`、-28 行)
- **mjc-main-20260505-24 Loop 48 ✅ 完了**: CHUNK_DURATION_SECS / CHUNK_SAMPLES 定数 2 件を transcription_whisper_stream.rs に移動 = チャンク設計定数の locality 集約 (使用元の WhisperStream と同居) (commit `57e1e13`、-10 行)
- **mjc-main-20260505-25 Loop 50 ✅ 完了**: MockEngine / MockStream impl + 3 tests (test_stream_lifecycle_feed_drain_finalize / test_stream_config_speaker_propagates_to_segments / test_feed_empty_samples_is_noop_in_mock) を transcription.rs から transcription_traits.rs に移動 = TranscriptionEngine / TranscriptionStream トレイト本体 + Mock 実装 + 3 tests 同居の locality 完成 (commit `3906d08`、-177 行)
- **mjc-main-20260505-25 Loop 51 ✅ 完了**: TranscriptionManager 関連 tests 6 件 (test_ensure_engine_creates_whisper_local_when_supported / test_ensure_engine_returns_error_for_unsupported_engine / test_ensure_engine_persists_engine_for_session / test_ensure_engine_returns_error_when_model_not_downloaded / test_validate_stream_count_for_engine_accepts_max_per_engine 系) を transcription.rs から transcription_manager.rs に移動 = ensure_engine 関数本体 + 6 tests 同居の locality 完成 (commit `451e720`、-107 行)
- **mjc-main-20260505-26 Loop 53 ✅ 完了**: StreamConfig Debug/Clone tests 3 件 (stream_config_debug_output_contains_struct_name_all_four_field_names_with_some_and_none / stream_config_debug_output_equals_after_clone_for_some_and_none_variants / stream_config_clone_produces_independent_copy_for_option_string_fields) を transcription.rs から transcription_traits.rs に移動 = StreamConfig 定義 + TranscriptionEngine/TranscriptionStream トレイト + Mock 実装 + 6 tests (Mock 3 + StreamConfig Debug/Clone 3) 同居の locality 完成 (commit `bbe9afc`、-134 行)
- **mjc-main-20260505-27 Loop 55 ✅ 完了**: tests mod 4 件 (should_emit_realtime_stream_error_is_logical_negation_of_already_stopped 1 件 → transcription_error_payload.rs / requested_transcription_sources Debug + Copy + PartialEq 3 件 → transcription_commands.rs) を一括移動 = transcription.rs tests mod 完全削除 + use 文 2 件完全削除 = 互換 re-export 5 件 + 区切りコメント + WHISPER_SAMPLE_RATE 1 const のみの **36 行最終形達成** = Phase 5 完了相当 (commit `93dcd18`、-157 行)
- **mjc-main-20260505-28 Loop 57 ✅ 完了**: WHISPER_SAMPLE_RATE 定数を audio_utils.rs に移動 + 互換 re-export 残置を clippy 検証で削除 = transcription.rs 36 → 29 行 = **99.0% 縮小達成 = Phase 5 完全終了 = 完全ファサード化** (commit `68c67d1`、-7 行)
- transcription.rs 残存 **29 行** = Phase 5 完全終了 = 完全ファサード化 (互換 re-export 5 件のみ、本体実装ゼロ・const ゼロ)、残る Tidy First 機会は (1) Phase 6 = 互換層削除 (transcription.rs 完全削除への migration、6 caller refactor、複数ループ計画推奨) / (2) docs / frontend / 検知拡張

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

同パターン (サービス別関数の独立モジュール化) は Whereby が Loop 31、GoToMeeting が Loop 36、Zoom が Loop 40、Microsoft Teams が Loop 43 で完了済み = **サービス別抽出シリーズ 5 件全完了** (Webex 29 + Whereby 31 + GoToMeeting 36 + Zoom 40 + Teams 43 = 5/14 ループ間隔)。次の Tidy First 候補は別パターン (worker_loop サブ抽出 / 純粋関数化 / docs 更新等) を選ぶ。

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

### app_detection_zoom.rs ✅ 完了 (mjc-main-20260505-20 Loop 40 = commit `99baa26`)

mjc-main-20260505-20 Loop 40 で Zoom 検知関数群を `src-tauri/src/app_detection_zoom.rs` に集約した。

- 関数 4 つ (`is_zoom_host` / `is_zoom_meeting_url` / `is_zoom_meeting_id` / `is_zoom_web_client_meeting_url`) を移動
- pub(crate) で公開 = `is_zoom_host` / `is_zoom_meeting_url`、Zoom 内部依存の `is_zoom_meeting_id` / `is_zoom_web_client_meeting_url` は private 維持
- ヘルパー `is_valid_dns_label` は Loop 29 (Webex 抽出) で `pub(crate)` 化済 = `use crate::app_detection::is_valid_dns_label` で取り込み
- ヘルパー `has_single_non_empty_segment` も既 `pub(crate)` のまま = `use crate::app_detection::has_single_non_empty_segment` で取り込み
- caller (`classify_meeting_url` 内の `is_zoom_meeting_url` 呼び出し) は `crate::app_detection_zoom::is_zoom_meeting_url` 経由に更新
- tests は classify_meeting_url 経由テストのみ = 直接呼びテストなし = use 文更新不要
- lib.rs に `mod app_detection_zoom` 宣言追加
- 振る舞い不変 = 702 passed 件数不変
- app_detection.rs 3184 → 3141 行 (-43 行)、app_detection_zoom.rs 0 → 44 行 (新規)

### app_detection_teams.rs ✅ 完了 (mjc-main-20260505-21 Loop 43 = commit `6bf1438`)

mjc-main-20260505-21 Loop 43 で Microsoft Teams 検知関数群を `src-tauri/src/app_detection_teams.rs` に集約した = **サービス別抽出シリーズ 5 件全完了里程標**。

- 関数 4 つ (`is_teams_meeting_url` / `is_teams_work_or_school_host` / `has_non_empty_path_segments` / `query_has_param`) を移動
- pub(crate) で公開 = `is_teams_meeting_url` のみ (caller 経由)、Teams 専用ヘルパー 3 件は新ファイル内 private 維持
- ヘルパー `has_single_non_empty_segment` は Loop 29 (Webex 抽出) で `pub(crate)` 化済 = `use crate::app_detection::has_single_non_empty_segment` で取り込み
- ヘルパー `query_has_non_empty_param` は Whereby 等の他サービスで使用するため app_detection.rs 残置 (`query_has_param` とは別物)
- caller (`classify_meeting_url` 内の `is_teams_meeting_url` 呼び出し) は `crate::app_detection_teams::is_teams_meeting_url` 経由に更新
- tests は classify_meeting_url 経由テストのみ = 直接呼びテストなし = use 文更新不要
- lib.rs に `mod app_detection_teams` 宣言追加 (アルファベット順: goto < teams < webex)
- 振る舞い不変 = 702 passed 件数不変
- app_detection.rs 3141 → 3109 行 (-32 行)、app_detection_teams.rs 0 → 48 行 (新規)
- **これにより app_detection.rs サービス別抽出シリーズは Webex/Whereby/GoToMeeting/Zoom/Teams の 5 件全完了** = 累計 -247 行 (3356 → 3109 行 = ~7.4% 縮小)

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

## 関連: transcription_types tests 移動 ✅ 完了 (mjc-main-20260505-19 Loop 38 = commit `64fe9cd`)

mjc-main-20260505-19 Loop 38 で transcription_types 関連テスト 10 件 (~426 行) を transcription.rs から `src-tauri/src/transcription_types.rs` に移動した。

- TranscriptionSegment 4 件: serialize / deserialize / debug / clone 系
- TranscriptionSource 3 件: from_str / display / round-trip 系
- ModelInfo 3 件: serialize / deserialize / equality 系
- 移動先には `mod tests` 新設 + `use super::*` を取り込み
- ModelInfo の unused import を削除 (移動時 cargo clippy --lib で検出 → 修正)
- 規模 M 一括 (Loop 35 15 件 ~290 行 precedent 1.4 倍規模 = バンドル判断 sweep 1 件 vs 単独 3 ループ分割 sweep 3 件 で variety 規則的に圧倒的有利と批判判断)
- 振る舞い不変 = 700 passed 件数不変、clippy 警告ゼロ、fmt OK
- transcription.rs 1175 → 749 行 (-426 行) = **75% 里程標突破**、transcription_types.rs 41 → 471 行 (+430 行)

## 関連: 沈黙検知三位一体 locality ✅ 完了 (mjc-main-20260505-21 Loop 42 + mjc-main-20260505-22 Loop 44)

沈黙検知関連 (関数 + テスト + 定数) の locality を audio_utils.rs に集約完成。

### Loop 42 = 沈黙検知テスト 6 件移動 (commit `5456409`)

- 移動対象: test_calculate_rms_empty_slice_returns_zero / test_calculate_rms_silence_signal_below_threshold / test_calculate_rms_voice_signal_above_threshold / test_is_tail_silent_returns_false_when_buffer_too_short / test_is_tail_silent_detects_voice_then_silence_pattern / test_is_tail_silent_rejects_voice_then_voice
- 移動先: audio_utils.rs 既存 tests mod (`use super::*` で関数アクセス済) に追記
- メイン批判判断: handoff candidate C の前提「移動先 = transcription_whisper_local.rs」を grep で実態確認 → calculate_rms / is_tail_silent の実体は audio_utils.rs L26 + L36 (`pub(crate)`) と判明 → audio_utils.rs に訂正
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 749 → 688 行 (-61 行)、audio_utils.rs 250 → 314 行 (+64 行)

### Loop 44 = 沈黙検知定数 3 件移動 (commit `52098b6`)

- 移動対象: `MIN_FLUSH_SAMPLES` (1 秒 @ 16kHz) / `SILENCE_LOOKBACK_SAMPLES` (0.5 秒 @ 16kHz) / `SILENCE_THRESHOLD_RMS` (-40dBFS 相当 = 0.01)
- 残置: `WHISPER_SAMPLE_RATE` / `CHUNK_DURATION_SECS` / `CHUNK_SAMPLES` は Whisper 仕様 = transcription.rs 残置
- 依存解決: audio_utils.rs に `use crate::transcription::WHISPER_SAMPLE_RATE;` import 追加
- use 文整理: transcription_whisper_stream.rs L7-10 の use 文整理 (3 const を audio_utils 経由に変更)、audio_utils.rs L255-257 の tests mod 内 `use crate::transcription::{...}` も `use super::{...}` に整理
- メイン批判判断: handoff 候補 A (規模 M リスク) と候補 D (docs 6 件目連続警告超過リスク) を排除し候補 E (沈黙検知定数移動) を採用 = variety + locality + 規模の三軸評価
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 688 → 678 行 (-10 行)、audio_utils.rs 314 → 324 行 (+10 行)

### 三位一体 locality の意義

- 関数 `calculate_rms` / `is_tail_silent` は元々 audio_utils.rs に存在 (Loop 32 で resample_audio テスト移動時の precedent から確認)
- Loop 42 でテスト 6 件、Loop 44 で定数 3 件を audio_utils.rs に集約 = **関数 + テスト + 定数すべてが audio_utils.rs に同居**
- これにより沈黙検知ロジックの理解性が大幅向上 (1 ファイル read で全体把握可能)
- AGENTS.md 優先順位 4 (リアルタイム文字起こし低遅延化) における将来の最適化対象特定が容易化

## 関連: WhisperStream tests 移動 ✅ 完了 (mjc-main-20260505-22 Loop 45 = commit `2a7190b`)

mjc-main-20260505-22 Loop 45 で WhisperStream 直接テスト 2 件 + 専用 helper を transcription_whisper_stream.rs に移動した = WhisperStream の locality 部分完成。

- 移動対象:
  - helper `stream_with_missing_resampler` (transcription.rs L63-76)
  - test `test_whisper_stream_feed_errors_when_resampler_state_missing` (L105-110)
  - test `test_whisper_stream_finalize_errors_when_resampler_state_missing` (L112-117)
- 移動先: `transcription_whisper_stream.rs` の新規 tests mod (`use super::*` + `use crate::transcription_traits::TranscriptionStream;`)
- 残置: Mock* trait テスト 3 件 (MockEngine / MockStream + impl + test_stream_lifecycle_feed_drain_finalize / test_stream_config_speaker_propagates_to_segments / test_feed_empty_samples_is_noop_in_mock) は `transcription_traits.rs` の locality に従って **Loop 47+ で別途処理予定**
- メイン批判判断: handoff 候補 A の規模見積「WhisperStream tests = 規模 M (~30-60 件)」を grep で実態確認 → 5 件 + helper のみと判明 → さらに 5 件のうち WhisperStream 直接関連は 2 件、Mock* trait test は 3 件と locality 区別 → Plan A (部分移動) で確実性最大化
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 678 → 649 行 (-29 行)、transcription_whisper_stream.rs 200 → 235 行 (+35 行)

## 関連: ModelManager tests 移動 ✅ 完了 (mjc-main-20260505-23 Loop 47 = commit `9e0a66b`)

mjc-main-20260505-23 Loop 47 で ModelManager 関連テスト 4 件 (~25 行) を transcription.rs から `src-tauri/src/transcription_model_manager.rs` に移動した = ModelManager の locality 完成。

- 移動対象 (transcription.rs L63-89):
  - `test_list_available_models_not_empty`
  - `test_list_available_models_includes_small`
  - `test_model_manager_get_path`
  - `test_model_not_downloaded_initially`
- 移動先: transcription_model_manager.rs の新規 `#[cfg(test)] mod tests` (`use super::*;` で ModelManager + with_dir(#[cfg(test)]) アクセス)
- transcription.rs L60 の `use crate::transcription_model_manager::ModelManager;` を削除 (移動後 unused、grep で 5/5 件すべて移動対象内 = 完全な切り分け可能と確定)
- メイン批判判断: handoff 候補 G を採用判断時、grep で transcription.rs の ModelManager 参照範囲を実態確認 → 5/5 件すべて移動対象内 = use 文同時削除可と確定 = メイン批判判断 連続 4 セッション目
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 649 → 621 行 (-28 行)、transcription_model_manager.rs 149 → 181 行 (+32 行)

## 関連: CHUNK 定数移動 ✅ 完了 (mjc-main-20260505-24 Loop 48 = commit `57e1e13`)

mjc-main-20260505-24 Loop 48 で CHUNK_DURATION_SECS / CHUNK_SAMPLES 定数 2 件を transcription.rs から `src-tauri/src/transcription_whisper_stream.rs` に移動した = チャンク設計定数の locality 集約。

- 移動対象 (transcription.rs L33-40):
  - `CHUNK_DURATION_SECS` (チャンクの蓄積目標 5 秒)
  - `CHUNK_SAMPLES` (16kHz × 5 秒 = 80,000 サンプル)
- 残置: `WHISPER_SAMPLE_RATE` (Whisper 仕様 = transcription.rs の最上位定数として継続、transcription_whisper_stream.rs / audio_utils.rs の両方から参照される広域定数のため)
- 移動先: transcription_whisper_stream.rs の `use` 文直後 (rustdoc コメント + セクションヘッダごと移植)
- import 整理: transcription_whisper_stream.rs L10 の `use crate::transcription::{CHUNK_DURATION_SECS, CHUNK_SAMPLES, WHISPER_SAMPLE_RATE};` を `use crate::transcription::WHISPER_SAMPLE_RATE;` に変更 (CHUNK_DURATION_SECS / CHUNK_SAMPLES は同ファイル内 self-contained 化)
- メイン批判判断: handoff 候補 H/F/J/K すべて却下し、grep で実態確認 → CHUNK_DURATION_SECS / CHUNK_SAMPLES の外部参照は transcription_whisper_stream.rs のみ (L70/L80/L81/L109) と判明 → locality 集約先を transcription_whisper_stream.rs に確定 = メイン批判判断 連続 5 セッション目
- variety pivot 軸 = struct/const 移動軸 = Loop 44 から 4 ループ間隔 = sweep 警告完全クリア
- Loop 33 (TranscriptionLoopConfig) / Loop 44 (沈黙検知 const) と同型 = 「const は使用箇所に locality 集約する」Tidy First 原則 3 件目
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 621 → 611 行 (-10 行)、transcription_whisper_stream.rs 235 → 245 行 (+10 行)

## 関連: Mock impl + tests 移動 ✅ 完了 (mjc-main-20260505-25 Loop 50 = commit `3906d08`)

mjc-main-20260505-25 Loop 50 で MockEngine / MockStream impl + 関連 tests 3 件 (~177 行) を transcription.rs から `src-tauri/src/transcription_traits.rs` に移動した = TranscriptionEngine / TranscriptionStream トレイト本体 + Mock 実装 + 3 tests 同居の locality 完成。

- 移動対象:
  - `MockEngine` struct + `TranscriptionEngine impl`
  - `MockStream` struct + `TranscriptionStream impl`
  - `test_stream_lifecycle_feed_drain_finalize` / `test_stream_config_speaker_propagates_to_segments` / `test_feed_empty_samples_is_noop_in_mock`
- 移動先: transcription_traits.rs の新規 `#[cfg(test)] mod tests` (`use super::*;` で StreamConfig / TranscriptionEngine / TranscriptionStream + Mock* アクセス) + 既存トレイト定義との locality 完成
- transcription.rs の use 文整理: 移動後に unused になった `use crate::transcription_traits::{TranscriptionEngine, TranscriptionStream};` 等を削除
- メイン批判判断: handoff 候補 F の前提「Mock 関連は transcription.rs L?? に存在 = 移動先 transcription_traits.rs」を grep で実態確認 → Mock 参照は transcription.rs tests mod 内のみ + transcription_traits.rs L7-16 で StreamConfig 定義 = locality 完璧と確定 = メイン批判判断 連続 6 セッション目
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 611 → 434 行 (-177 行)、transcription_traits.rs 48 → 229 行 (+181 行)

## 関連: TranscriptionManager tests 移動 ✅ 完了 (mjc-main-20260505-25 Loop 51 = commit `451e720`)

mjc-main-20260505-25 Loop 51 で TranscriptionManager 関連 tests 6 件 (~107 行) を transcription.rs から `src-tauri/src/transcription_manager.rs` に移動した = ensure_engine 関数本体 + 6 tests 同居の locality 完成。

- 移動対象 (TranscriptionManager / ensure_engine 関連 tests 6 件):
  - `test_ensure_engine_creates_whisper_local_when_supported`
  - `test_ensure_engine_returns_error_for_unsupported_engine`
  - `test_ensure_engine_persists_engine_for_session`
  - `test_ensure_engine_returns_error_when_model_not_downloaded`
  - `test_validate_stream_count_for_engine_accepts_max_per_engine` 系を含む 6 件
- 移動先: transcription_manager.rs の新規 / 既存 `#[cfg(test)] mod tests` (`use super::*;` で TranscriptionManager + ensure_engine アクセス)
- transcription.rs の use 文整理: 移動後に unused になった use 文を完全削除 (1 ループ完結)
- メイン批判判断: handoff サマリ予測「3 件・規模 SS」を grep で実態確認 → 「6 件・規模 SS-S」訂正 → 一括移動で use 文完全削除 + 1 ループ完結 + locality 完璧の 3 点優位達成 = メイン批判判断 連続 6 セッション目
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 434 → 327 行 (-107 行)、transcription_manager.rs 124 → 235 行 (+111 行)

## 関連: StreamConfig Debug/Clone tests 移動 ✅ 完了 (mjc-main-20260505-26 Loop 53 = commit `bbe9afc`)

mjc-main-20260505-26 Loop 53 で StreamConfig Debug/Clone tests 3 件 (~134 行) を transcription.rs から `src-tauri/src/transcription_traits.rs` に移動した = StreamConfig 定義 + TranscriptionEngine / TranscriptionStream トレイト + Mock 実装 + 関連 tests 6 件 同居の完全 locality 完成。

- 移動対象 (StreamConfig Debug/Clone セマンティクス検証 tests 3 件):
  - `stream_config_debug_output_contains_struct_name_all_four_field_names_with_some_and_none`
  - `stream_config_debug_output_equals_after_clone_for_some_and_none_variants`
  - `stream_config_clone_produces_independent_copy_for_option_string_fields`
- 移動先: transcription_traits.rs 既存 `#[cfg(test)] mod tests` (Loop 50 で追加した Mock 関連 3 tests と同居) = 6 tests 同居の locality 完成
- transcription_traits.rs L52-55 既存 use 文 (`use super::*` + `use crate::transcription_types::{TranscriptionSegment, TranscriptionSource}`) で新規 3 tests の依存全 import 済 = use 文追加変更なし
- transcription.rs の `use super::*;` 削除 (移動後に残置 tests = should_emit + RequestedTranscriptionSources 3 件 で完全 unused)
- メイン批判判断: handoff 候補 M の予測「StreamConfig Debug tests 4 件」を grep で実態確認 → 3 件 (StreamConfig 関連) と判明 → 訂正後採用 = メイン批判判断 連続 7 セッション目
- variety pivot 軸 = test 軸 = Loop 51 から 2 ループ pivot (Loop 52 docs) 後 = sweep 警告から復帰許容
- 振る舞い不変 = 702 passed 件数不変
- transcription.rs 327 → 193 行 (-134 行) = **90% 里程標突破達成**、transcription_traits.rs 229 → 366 行 (+137 行 = StreamConfig 関連 + コメント)

## 関連: tests mod 完全削除 = 36 行最終形達成 ✅ 完了 (mjc-main-20260505-27 Loop 55 = commit `93dcd18`)

mjc-main-20260505-27 Loop 55 で transcription.rs の tests mod 4 件 (~157 行) を 2 ファイルに一括分散移動した = **transcription.rs 36 行最終形達成 = Phase 5 完了相当**。

- 移動対象 (transcription.rs L38-193 = 区切りコメント + tests mod 全体):
  - `should_emit_realtime_stream_error_is_logical_negation_of_already_stopped` (~16 行) → `transcription_error_payload.rs` (should_emit / is_already_stopped 関数本体と同居)
  - `requested_transcription_sources_debug_output_contains_struct_name_and_both_field_names` (~73 行) → `transcription_commands.rs`
  - `requested_transcription_sources_copy_semantics_allow_use_after_move` (~21 行) → `transcription_commands.rs`
  - `requested_transcription_sources_partial_eq_holds_reflexive_and_differs_for_each_field` (~31 行) → `transcription_commands.rs` (RequestedTranscriptionSources struct と同居 = locality 完璧)
- transcription.rs の use 文 2 件完全削除 (`RequestedTranscriptionSources` / `should_emit + is_already_stopped`) = 移動後 unused
- 移動先既存 / 新規 `#[cfg(test)] mod tests` (`use super::*;` で関連 struct / 関数アクセス)
- メイン批判判断: handoff サマリの「候補 P (3 tests, Loop 55+) と候補 Q (1 件, Loop 55+) を別ループで実施」案を grep で実態確認 → 4 tests 全て transcription.rs tests mod の唯一の構成要素 + use 文 2 件もこれらの tests のみで使用と判明 → **1 ループでマージ移動すれば transcription.rs tests mod 完全削除 + use 文 2 件完全削除 + 36 行最終形に到達** と訂正採用 = メイン批判判断 連続 8 セッション目達成
- variety pivot 軸 = test 軸 = Loop 53 から 1 ループ pivot (Loop 54 docs) 後 + 1 ループでまとめて最終形へ移行 = 後続 Loop 56+ で完全な軸 pivot へ移行可能
- 振る舞い不変 = 702 passed 件数不変、clippy 警告ゼロ、fmt OK
- transcription.rs 193 → **36 行** (-157 行) = **98.8% 縮小最終形** (元 2999 行から累計 -2963 行)、transcription_error_payload.rs 343 → 360 行 (+17 行)、transcription_commands.rs 598 → 717 行 (+119 行)

### Phase 5 完了相当の意義

- transcription.rs は元 2999 行 = リポジトリ最大級 → 36 行 = 互換 re-export 5 件 + 区切りコメント + `WHISPER_SAMPLE_RATE` 1 const のみ
- 全ての具体実装 (データ型 / トレイト / Whisper エンジン / Model 管理 / TranscriptionManager / Tauri commands / Worker loop / Audio 処理 / 沈黙検知) は別モジュールに locality 集約済
- 残る課題は (1) WHISPER_SAMPLE_RATE 移動最終判断 (audio_utils.rs と新規 transcription_constants.rs の選択 = Phase 5 仕上げ判断) / (2) Phase 6 = 互換 re-export 層削除 (全 caller の `use crate::transcription::...` を直接 import に書き換え、規模 M、複数ループ計画推奨) の 2 軸
- AGENTS.md 優先順位 1 (クラッシュ修正) / 4 (リアルタイム文字起こし低遅延化) への予防的寄与 = 巨大ファイル理解難度を最大限まで低減達成

## 関連: WHISPER_SAMPLE_RATE 移動 + 互換層削除 = 29 行最終形達成 ✅ 完了 (mjc-main-20260505-28 Loop 57 = commit `68c67d1`)

mjc-main-20260505-28 Loop 57 で transcription.rs から `WHISPER_SAMPLE_RATE` 定数を audio_utils.rs に移動し、さらに互換 re-export 残置を clippy 検証で削除した = **transcription.rs 29 行最終形達成 = Phase 5 完全終了 = 完全ファサード化**。

- 移動対象: `pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16_000;` (transcription.rs 唯一の本体実装)
- 移動先: audio_utils.rs L25 = 既存の `use crate::transcription::WHISPER_SAMPLE_RATE;` を const 定義に置換 (self-reference 解消)
- 連動変更: transcription_whisper_stream.rs L6 既存 use ブロックに WHISPER_SAMPLE_RATE 統合 (別 use 文 → ブロック合流 = -1 行)
- 互換層判断: 当初 `pub(crate) use crate::audio_utils::WHISPER_SAMPLE_RATE;` を transcription.rs に残置する設計だったが、`cargo clippy --lib --tests -- -D warnings` で「unused import」エラーを検出 (= 既に呼び出し元ゼロ、各 caller は audio_utils 経由で参照済) → 残置せず削除が正解と判断
- メイン批判判断: handoff サマリの「audio_utils.rs vs 新規 transcription_constants.rs」案を grep で実態確認 → transcription_whisper_stream.rs L6 が既に audio_utils を import している = audio_utils.rs 配置で単方向依存 + 沈黙検知三位一体 locality (Loop 44) と一貫 + 新規ファイル不要 = audio_utils.rs に確定 = メイン批判判断 連続 9 セッション目達成
- 振る舞い不変 = 702 passed 件数不変、clippy 警告ゼロ、fmt OK
- transcription.rs 36 → **29 行** (-7 行) = **99.0% 縮小最終形** (元 2999 行から累計 -2970 行)
- audio_utils.rs 324 → 325 行 (+1 行) = 沈黙検知 3 const + WHISPER_SAMPLE_RATE 1 件 + 関数 + tests = sample_rate 系 4 件統合 locality 完璧
- transcription_whisper_stream.rs 245 → 244 行 (-1 行) = use ブロック統合

### Phase 5 完全終了 = transcription.rs 完全ファサード化の意義

- transcription.rs 29 行最終形 = 互換 re-export 5 件のみ (本体実装ゼロ・const ゼロ):
  - L1-5: TranscriptionSegment / TranscriptionSource (transcription_types.rs)
  - L7-11: StreamConfig / TranscriptionEngine / TranscriptionStream (transcription_traits.rs)
  - L13-17: WhisperStream (transcription_whisper_stream.rs)
  - L19-23: TranscriptionStateHandle (transcription_manager.rs)
  - L25-29: TranscriptionLoopConfig (transcription_worker_loop.rs)
- WHISPER_SAMPLE_RATE は audio_utils.rs に集約 = sample_rate 系 4 件 + 沈黙検知関数 + tests の locality 完璧
- 残る課題は **Phase 6 のみ** = 互換 re-export 5 件を全 caller (cloud_whisper.rs / elevenlabs_realtime.rs / transcript_bridge.rs / transcription_commands.rs / transcription_panic_guard.rs / transcription_whisper_local.rs の 6 ファイル) で直接 import に書き換え、最終的に transcription.rs ファイル自体を削除する migration (規模 M、6 ループ計画推奨)
- AGENTS.md 優先順位 1 (クラッシュ修正) / 4 (リアルタイム文字起こし低遅延化) への予防的寄与 = 巨大ファイル理解難度低減を最大限まで達成 (元 2999 行 = 9 責務混在 → 9 責務全て独立モジュールに locality 集約 + transcription.rs 自体は ファサード)

## 関連: Phase 6 完全終了 = transcription.rs ファイル削除 = 100% 達成 ✅ 完了 (mjc-main-20260505-30 Loop 60-61 + mjc-main-20260505-31 Loop 62-63 系列)

mjc-main-20260505-30 Loop 60 ~ mjc-main-20260505-31 Loop 63 の 4 ループで Phase 6 (互換 re-export 層削除) を完全完遂し、transcription.rs ファイル自体を削除した = **元 2999 行 → 0 行 (ファイル削除) = 100% 達成 = リファクタプラン完全完遂**。

### Phase 6 各歩 (4 ループ完了系列)

- **第 1 歩 ✅ 完了 (Loop 59 = commit `d676fd5`)**: TranscriptionSegment / TranscriptionSource caller 直接 import 化 (4 ファイル / 7 箇所 use 文)
- **第 2 歩 ✅ 完了 (Loop 60 = commit `d7bdc61`)**: StreamConfig / TranscriptionEngine / TranscriptionStream caller 直接 import 化 + transcript_bridge.rs インライン参照 3 箇所 + elevenlabs/openai file-level use ブロック分割 (5 ファイル / 8 箇所) + transcription.rs L5 + L11 に `#[allow(unused_imports)]` 追加
- **第 3 歩 + 第 4 歩統合 ✅ 完了 (Loop 61 = commit `64aa904`)**: WhisperStream caller 直接 import 化 + TranscriptionStateHandle インライン参照修正 (3 ファイル / 4 箇所) + transcription.rs L19 + L26 に `#[allow(unused_imports)]` 追加 = T+U 統合判断で timeline 4 → 3 ループに圧縮 ~25% 効率化
- **第 5 歩 ✅ 完了 (Loop 62 = commit `48c6558`)**: TranscriptionLoopConfig caller 直接 import 化 (2 ファイル / 2 use 文 = panic_guard:6 + commands:5) + transcription.rs L33 に `#[allow(unused_imports)]` 追加
- **最終 ✅ 完了 (Loop 63 = commit `<COMMIT_HASH>`)**: transcription.rs ファイル削除 + lib.rs から `mod transcription;` 宣言削除 + plan.md 100% 達成記念更新 = **Phase 6 完全終了 = リファクタプラン完全完遂**

### `#[allow(unused_imports)]` 第 3 解パターン (Loop 60 で発見、Loop 61-62 継承)

Phase 6 移行中に互換 re-export を残す必要があったが、全 caller を直接 import 化すると `pub use` が unused になる。Loop 57 で発見された「unused なら削除が正解」とは逆に、移行中は **`#[allow(unused_imports)]` を付けて互換層維持しつつ clippy 警告を抑制** する第 3 解が Loop 60 で発見された。これにより worker は段階的に caller を書き換えながら、各ループで cargo clippy 警告ゼロを維持できた。Loop 63 (本ループ) で transcription.rs ファイル自体を削除することで、互換層と allow 注記がすべて消滅 = 完全に解消。

### Phase 6 完全終了 = リファクタプラン完全完遂の意義

- transcription.rs は元 2999 行 = リポジトリ最大級の単一ファイル (9 責務混在) → **ファイル削除 = 0 行 = 100% 完遂**
- 9 責務すべてが独立モジュールに locality 集約完了:
  - データ型 → transcription_types.rs
  - トレイト → transcription_traits.rs
  - Whisper エンジン → transcription_whisper_local.rs / transcription_whisper_stream.rs
  - Model 管理 → transcription_model_manager.rs
  - Transcription state → transcription_manager.rs
  - Audio resampling + 沈黙検知 → audio_utils.rs (沈黙検知三位一体 locality)
  - Tauri commands → transcription_commands.rs
  - Worker loop → transcription_worker_loop.rs / transcription_panic_guard.rs / transcription_emission.rs / transcription_error_payload.rs
- AGENTS.md 優先順位 1 (クラッシュ修正) / 4 (リアルタイム文字起こし低遅延化) への予防的寄与 = 巨大ファイル理解難度低減を **完全達成** (= 9 責務混在状態が完全解消、各責務単独で理解可能 + 最適化対象特定容易)
- 後続 Tidy First 機会は (1) docs / 進捗サマリ刷新 / (2) frontend 軸 (LiveCaptionWindow.tsx 580 行 / MeetingDetectedBanner.tsx 526 行) / (3) 検知拡張 (Discord stage / Slack Huddle 等) / (4) audio*.rs / session*.rs / app_detection*.rs の責務分離 (該当ファイルが 1000 行超ならば検討) などへ移行

## 参考

- 本プランは mjc-main-20260505-3 (Loop 4) で grep ベース構造分析により作成。
- 実コードは生きており、Phase 着手時に再度行範囲・責務分類の妥当性を検証する必要がある。
- 各 Phase 着手時は必ず最新の `transcription.rs` を read して、本プランの行範囲とずれていないか確認する。
- (本プラン作成時の 2999 行は mjc-main-20260505-3 時点。mjc-main-20260505-31 Loop 63 時点で **ファイル削除完了 = 100% 達成** = 95% / 98% / 99% / 100% 里程標完全制覇 = Phase 6 完全終了 = リファクタプラン完全完遂)
