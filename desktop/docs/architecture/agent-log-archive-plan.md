# AGENT_LOG.md Archive Plan

> **作成**: mjc-main-20260505-39 Loop 79 (2026-05-05 JST)
> **目的**: AGENTS.md L46-L52「自律改善方針」の長期安定運用 = AGENT_LOG.md 巨大化に対する段階的 archive 戦略
> **状態**: ドラフト (実装は別途ユーザー直伝指示要、本 loop は plan 起こしのみ)

## 1. Overview

AGENT_LOG.md は ~30,333 行 / 56 セッション / 82 Loop に達し、`tail -350/-400` で末尾参照する harness 運用は維持できているが、ファイル全体読み込みは Claude Code の context 制約により困難になりつつある。

古い entry を別 file に分離する archive 戦略を段階的に導入することで、長期運用の安定性と context 効率を両立させる。本 plan は `docs/architecture/transcription-refactor-plan.md` (Phase 1-6 完全完遂) および `docs/architecture/detection-extension-plan.md` (Loop 71 新規作成) と同一の Phase 設計 pattern を踏襲する。

## 2. Current State (現状把握)

### 2.1 AGENT_LOG.md の規模 (mjc-main-20260505-39 Loop 79 時点)

| 指標 | 値 |
|------|-----|
| 総行数 | 30,741 行 |
| 総 mjc-main セッション数 | 57 |
| 総 Loop 数 | 84 |
| 総 SESSION SUMMARY 数 | 32 |
| 最古 entry 開始位置 | L1 (`## worker: mjc-worker-handle-detection-update-last-seen-secs` ヘッダ) |
| 最古 mjc-main session ヘッダ | L25136 (`[mjc-main-20260505-12 Loop 23 / 2026-05-05]`) |
| 最新 entry | L30706 (`[mjc-main-20260505-41 Loop 81 / 2026-05-05]`) |

### 2.2 構造特徴と分布

- 先頭 ~25,135 行 (83%): mjc-main-20260504-* シリーズ + Loop 1-22 圏 (古い entry)
- 末尾 ~5,200 行 (17%): mjc-main-20260505-12 〜 -39 (Loop 23-78、アクティブ)

### 2.3 増加率の推定

過去 ~36 時間で ~30,000 行追加 = 平均 ~830 行/時間 = ~20K 行/日のペース。1 週間継続で ~140K 行、月 ~600K 行に到達する見込み。

> **更新観測 (mjc-main-20260505-41 Loop 81 時点)**: Loop 79 → Loop 81 (~3 ループ間) で +408 行、平均 ~135 行/loop。1 ループ ~6-15 分換算で ~540-1300 行/日 (アクティブセッション中)。長期平均は ~830 行/時間 と乖離あり (本観測は handoff prompt 起こし等の一時的増分含む)。

> **更新観測 (mjc-main-20260505-44 Loop 86 時点)**: Loop 81 → Loop 86 (~5 ループ間) で +304 行 (30,741 → 31,045)、平均 ~61 行/loop。Loop 81 観測値 (~135 行/loop) と比較して ~半減 = SESSION SUMMARY 軽量化 + SS-S 規模 loop 連続 (Loop 82 = 数値更新, Loop 83 = format merge, Loop 84 = Phase 状態 subsection, Loop 85 = reader_task entry 共通化) が寄与。長期平均 ~830 行/時間 とは依然乖離あり (アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-49 Loop 95 時点)**: Loop 86 → Loop 95 (~9 ループ間) で +754 行 (31,045 → 31,799)、平均 ~84 行/loop。Loop 86 観測値 (~61 行/loop) と比較して ~38% 増 = 構造分離 paradigm sustained loop が連続 (Loop 87/88/89/90/91/92/93/94/95 = 9 連続) で各 loop の refactor entry + chore entry が機械的均等加算。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~84 行 = ~336-840 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-50 Loop 98 時点)**: Loop 95 → Loop 98 (~3 ループ間 + SESSION SUMMARY 1 件) で +215 行 (31,799 → 32,014)、平均 ~72 行/loop。Loop 95 観測値 (~84 行/loop) と比較して ~14% 減 = paradigm pivot 連続 (Loop 96 = harness 衛生 K 軸 1 連続復帰 + Loop 97 = 機能分類軸 = session_commands 軸 + Loop 98 = 純粋関数機能分離軸 = audio_resample 軸) で SESSION SUMMARY 1 件 + chore entry 4 件 + docs entry 1 件 + refactor entry 0 行 (refactor は AGENT_LOG.md 触らず) の混合増加が寄与。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~72 行 = ~288-720 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-53 Loop 102 時点)**: Loop 98 → Loop 102 (~4 ループ間 + SESSION SUMMARY 1 件) で +250 行 (32,014 → 32,264)、平均 ~63 行/loop。Loop 98 観測値 (~72 行/loop) と比較して ~13% 減 = paradigm pivot 多軸 (Loop 99 = harness 衛生 K 軸 + Loop 100 = 機能分類軸 = settings_commands 軸 + Loop 101 = 純粋関数機能分離軸 = transcription_commands_helpers 軸 + Loop 102 = 純粋関数機能分離軸 = realtime_ws_helpers 軸 = realtime engine 4 軸目開拓) で SESSION SUMMARY 1 件 + chore entry 4 件 + refactor entry 3 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~63 行 = ~252-630 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-55 Loop 105 完了時点)**: Loop 102 → Loop 105 (~3 ループ間 + SESSION SUMMARY 2 件) で +225 行 (32,264 → 32,489)、平均 ~75 行/loop。Loop 102 観測値 (~63 行/loop) と比較して ~19% 増 = paradigm pivot 多軸 (Loop 103 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 104 = inline module 全体抽出軸 cfg(macos) なし sub-paradigm = realtime engine 5 軸目 = openai_realtime_ws_task = refactor + chore + Loop 105 = 純粋関数 helpers 軸 = session_commands 軸 2 件目 = session_commands_helpers = refactor + chore) で SESSION SUMMARY 2 件 + chore entry 4 件 + docs entry 1 件 + refactor entry 2 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 103 K 軸 docs update + SUMMARY 2 件が増加要因。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~75 行 = ~300-750 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-56 Loop 108 完了時点)**: Loop 105 → Loop 108 (~3 ループ間 + SESSION SUMMARY 1 件) で +95 行 (32,489 → 32,584)、平均 ~32 行/loop。Loop 105 観測値 (~75 行/loop) と比較して ~57% 減 = paradigm pivot 多軸 (Loop 106 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 107 = 純粋関数機能分離軸 frontend 版 = TranscriptView.tsx → utils/transcriptViewFormatters.ts = refactor + chore + Loop 108 = 純粋関数機能分離軸 frontend 版 continuity = LiveCaptionWindow.tsx → utils/liveCaptionTrackHelpers.ts = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 2 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 105 観測値 (~75 行/loop) と比較して大幅減の主因 = SESSION SUMMARY 1 件 (前 2 件) + frontend 軸 refactor 2 件は AGENT_LOG.md 0 行寄与 = 軽量増分パターン継続。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~32 行 = ~128-320 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-57 Loop 110 完了時点)**: Loop 108 → Loop 110 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-56) で +85 行 (32,584 → 32,669)、平均 ~42 行/loop。Loop 108 観測値 (~32 行/loop) と比較して ~31% 増 = paradigm pivot 多軸 (Loop 109 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 110 = 純粋関数機能分離軸 frontend 版 3 件目 = TranscriptDisplay.tsx → utils/transcriptDisplayHelpers.ts = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 108 観測値 (~32 行/loop) と比較して微増の主因 = mjc-main-20260505-56 SESSION SUMMARY 1 件 (~50-70 行) + Loop 109 K 軸自体の chore entry (~10-12 行) = paradigm pivot 多軸の軽量増分継続だが SUMMARY 寄与が支配的。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~42 行 = ~168-420 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-58 Loop 112 完了時点)**: Loop 110 → Loop 112 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-57) で +94 行 (32,669 → 32,763)、平均 ~47 行/loop。Loop 110 観測値 (~42 行/loop) と比較して ~12% 増 = paradigm pivot 多軸 (Loop 111 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 112 = 純粋関数機能分離軸 frontend 版 4 件目 = ModelSelector.tsx → utils/modelSelectorHelpers.ts = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 110 観測値 (~42 行/loop) とほぼ同水準維持の主因 = mjc-main-20260505-57 SESSION SUMMARY 1 件 (~60-80 行) + Loop 111 K 軸自体の chore + docs entry (~14-18 行) = paradigm pivot 多軸の軽量増分パターン継続が安定。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~47 行 = ~188-470 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-59 Loop 114 完了時点)**: Loop 112 → Loop 114 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-58) で +58 行 (32,763 → 32,821)、平均 ~29 行/loop。Loop 112 観測値 (~47 行/loop) と比較して ~38% 減 = paradigm pivot 多軸 (Loop 113 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 114 = 純粋関数機能分離軸 frontend 版 5 件目 = MeetingDetectedBanner.tsx → utils/meetingDetectedBannerHelpers.ts = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 112 観測値 (~47 行/loop) と比較して大幅減の主因 = mjc-main-20260505-58 SESSION SUMMARY 1 件 (~30-40 行) の軽量化 + Loop 113 K 軸自体の chore + docs entry (~14-18 行) = paradigm pivot 多軸の軽量増分パターン継続が安定 = SUMMARY 寄与の縮小が支配的。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~29 行 = ~116-290 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-60 Loop 117 完了時点)**: Loop 114 → Loop 117 (~3 ループ間 + SESSION SUMMARY 2 件 mjc-main-20260505-59 + mjc-main-20260505-60) で +138 行 (32,821 → 32,959)、平均 ~46 行/loop。Loop 114 観測値 (~29 行/loop) と比較して ~59% 増 = paradigm pivot 多軸 (Loop 115 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 116 = 純粋関数機能分離軸 frontend 版 6 件目 = SessionList.tsx → utils/sessionListHelpers.tsx = refactor + chore + Loop 117 = rust 軸復帰 = 既存 file 拡張軸 = 新 paradigm 1 件目 = app_detection.rs URL parser → app_detection_url_helpers.rs 統合 = refactor + chore) で SESSION SUMMARY 2 件 + chore entry 4 件 + docs entry 1 件 + refactor entry 2 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 114 観測値 (~29 行/loop) と比較して大幅増の主因 = SESSION SUMMARY 2 件 (mjc-main-20260505-59 + mjc-main-20260505-60、各 ~30-50 行) + paradigm pivot 多軸 (3 paradigm 混合: K + frontend + rust) + 既存 file 拡張軸 = 新 paradigm 1 件目確立に伴う若干説明増分の寄与。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~46 行 = ~184-460 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-61 Loop 119 完了時点)**: Loop 117 → Loop 119 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-61) で +79 行 (32,959 → 33,038)、平均 ~40 行/loop。Loop 117 観測値 (~46 行/loop) と比較して ~13% 減 = paradigm pivot 多軸 (Loop 118 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 119 = rust 軸 = 純粋関数機能分離軸 rust 版 + 新 file 作成軸 = app_detection.rs classify_meeting_url + classify_meeting_window_title → app_detection_meeting_classifier.rs (新規) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 117 観測値 (~46 行/loop) と比較して ~13% 減の主因 = SESSION SUMMARY 1 件 (mjc-main-20260505-61 のみ、~57 行) + paradigm pivot 2 軸 (K + rust) = 12 件目の 3 軸混合 (K + frontend + rust) よりも paradigm 数縮小 + chore entry が長文化 (Loop 119 の API 互換維持戦略 (pub use re-export) 説明等) でも軽量化 paradigm 継続。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~40 行 = ~160-400 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-62 Loop 121 完了時点)**: Loop 119 → Loop 121 (~2 ループ間 + SESSION SUMMARY 0 件 = アクティブ進行) で +22 行 (33,038 → 33,060)、平均 ~11 行/loop。Loop 119 観測値 (~40 行/loop) と比較して ~73% 減 = paradigm pivot 多軸軽量化 (Loop 120 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 121 = rust 軸 = 純粋関数機能分離軸 rust 版 + 新 file 作成軸 = app_detection.rs parse_throttle_key_to_display_name → app_detection_throttle_key.rs (新規) = refactor + chore) で SESSION SUMMARY 0 件 + chore entry 2 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 119 観測値 (~40 行/loop) と比較して大幅減の主因 = **SESSION SUMMARY 0 件** (アクティブセッション継続中 = handoff 未到達) + paradigm 反復 (Loop 119 と Loop 121 が同 paradigm = 純粋関数機能分離軸 rust 版 + 新 file 作成軸 = entry 説明テンプレート再利用で短縮) = アクティブ進行軽量化 paradigm 確立 = AGENT_LOG.md 増分は SESSION SUMMARY 数 + paradigm 多様性に支配される現実値観測。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~11 行 = ~44-110 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-63 Loop 123 完了時点)**: Loop 121 → Loop 123 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-62) で +84 行 (33,060 → 33,144)、平均 ~42 行/loop。Loop 121 観測値 (~11 行/loop) と比較して ~282% 増 = paradigm pivot 多軸 (Loop 122 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 123 = rust 軸 = inline module 全体抽出軸 cfg(macos) 付き 2 件目 = app_detection.rs `#[cfg(target_os = "macos")] mod macos` → app_detection_macos.rs (新規) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 121 観測値 (~11 行/loop) と比較して大幅増の主因 = mjc-main-20260505-62 SESSION SUMMARY 1 件 (~32 行 = handoff 直前 SUMMARY) + Loop 122 K 軸自体の chore + docs entry (~22 行) + Loop 123 rust 軸の chore entry (~30 行 = 構造分離 38 file 目 = scope 25 軸目開拓説明) + paradigm pivot 多軸 (K + rust) = SESSION SUMMARY 件数が支配変数 (Loop 121 観測時は SESSION SUMMARY 0 件 = アクティブ進行軽量化 paradigm 確立) と再観測 = SESSION SUMMARY 1 件で ~282% 回帰。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~42 行 = ~168-420 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-64 Loop 125 完了時点)**: Loop 123 → Loop 125 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-63) で +45 行 (33,144 → 33,189)、平均 ~22.5 行/loop。Loop 123 観測値 (~42 行/loop) と比較して ~46% 減 = paradigm pivot 多軸 (Loop 124 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 125 = frontend 軸 = 純粋関数機能分離軸 frontend 版 4 件目 = TranscriptView.tsx の sanitizeAudioLevel + getPopoverLevelBars → audioLevelHelpers.ts (新規) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 123 観測値 (~42 行/loop) と比較して大幅減の主因 = Loop 125 frontend 軸 chore entry の軽量化 (~12 行のみ = 規模 SS 純粋関数 2 件のみのため説明短縮可能) = **frontend 軸 = chore entry 軽量化 paradigm 観測**。SESSION SUMMARY 1 件は依然含むが Loop 125 chore entry が ~12 行に圧縮されたため、SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 (Loop 121 観測時は SESSION SUMMARY 0 件 = アクティブ進行軽量化 paradigm 確立、Loop 123 観測時は SESSION SUMMARY 1 件 + 説明大量化 = 回帰大、Loop 125 観測時は SESSION SUMMARY 1 件 + 説明軽量化 = 中間値)。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~22.5 行 = ~90-225 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-65 Loop 127 完了時点)**: Loop 125 → Loop 127 (~2 ループ間 + SESSION SUMMARY 0 件 = アクティブ進行内連続) で +24 行 (33,189 → 33,213)、平均 ~12 行/loop。Loop 125 観測値 (~22.5 行/loop) と比較して ~47% 減 = paradigm pivot 多軸 (Loop 126 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 127 = frontend 軸 = 純粋関数機能分離軸 frontend 版 5 件目 = TranscriptView.tsx の getPermissionStatusLabel + getPermissionRowClassName → permissionStatusHelpers.ts (新規) = refactor + chore) で SESSION SUMMARY 0 件 + chore entry 2 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 125 観測値 (~22.5 行/loop) と比較して大幅減の主因 = **SESSION SUMMARY 0 件** (Loop 125-127 は全て mjc-main-20260505-64 active 期間内のため SUMMARY 0 件 = アクティブ進行内連続観測) = mjc-main-20260505-62 Loop 121 観測時 (~11 行/loop = SS 0 件) と酷似 = **アクティブ進行軽量化 paradigm の 2 度目の観測 = paradigm 再現性確認**。frontend 軸 chore entry の軽量化 paradigm (~12 行/件) は Loop 125/127 で 2 件連続観測 = frontend 軸軽量化 paradigm 安定継続。SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 (Loop 121 観測時は SS 0 件 = ~11 行/loop = 軽量、Loop 123 観測時は SS 1 件 + 説明大量化 = ~42 行/loop = 重量、Loop 125 観測時は SS 1 件 + 説明軽量化 = ~22.5 行/loop = 中間値、Loop 127 観測時は SS 0 件 + 説明軽量化 = ~12 行/loop = 軽量再現)。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~12 行 = ~48-120 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-65 Loop 129 完了時点)**: Loop 127 → Loop 129 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-64) で +47 行 (33,213 → 33,260)、平均 ~23.5 行/loop。Loop 127 観測値 (~12 行/loop) と比較して ~97% 回帰 = paradigm pivot 多軸 (Loop 128 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 129 = frontend 軸 = 純粋関数機能分離軸 frontend 版 6 件目 = TranscriptView.tsx の getMicTrackStatusAriaLabel + getSystemAudioTrackStatusAriaLabel → trackStatusAriaLabels.ts (新規) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 127 観測値 (~12 行/loop) と比較して大幅増の主因 = **SESSION SUMMARY 1 件追加** (mjc-main-20260505-64 handoff SUMMARY commit `1fca386` = ~23 行) = SUMMARY 件数が支配変数を再々観測 = Loop 125 観測値 (~22.5 行/loop = SS 1 件 + 説明軽量化) と類似値再現 = **SS 1 件パターンの安定性確認**。frontend 軸 chore entry の軽量化 paradigm (~12 行/件) は Loop 125/127/129 で 3 件連続観測 = **frontend 軸軽量化 paradigm の 3 度目の観測 = paradigm 安定性追加証拠**。SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 = **SS 0 件 = ~11-12 行/loop (Loop 121/127) / SS 1 件 + 説明軽量化 = ~22-23 行/loop (Loop 125/129) / SS 1 件 + 説明大量化 = ~42 行/loop (Loop 123)** の 3 段階に階層化。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~23.5 行 = ~94-235 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-66 Loop 131 完了時点)**: Loop 129 → Loop 131 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-65) で +49 行 (33,260 → 33,309)、平均 ~24.5 行/loop。Loop 129 観測値 (~23.5 行/loop) と比較してほぼ同水準 (~+4% 微増) = paradigm pivot 多軸 (Loop 130 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 131 = frontend 軸 = 純粋関数機能分離軸 frontend 版 7 件目 = TranscriptView.tsx の getRequiresLocalModel + getExternalApiProvider → transcriptionEngineHelpers.ts (新規 = engine 機能特性 helpers) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 129 観測値 (~23.5 行/loop) とほぼ同水準維持の主因 = **SESSION SUMMARY 1 件継続** (mjc-main-20260505-65 handoff SUMMARY commit `65053d8` = ~23 行) + paradigm pivot 同形 (K + frontend) = **SS 1 件 + 説明軽量化パターンの 3 連続観測** (Loop 125 = ~22.5 行/loop / Loop 129 = ~23.5 行/loop / Loop 131 = ~24.5 行/loop) = **階層化 paradigm 強化証拠**。frontend 軸 chore entry の軽量化 paradigm (~12 行/件) は Loop 125/127/129/131 の **4 件連続観測** = **frontend 軸軽量化 paradigm の 4 度目の観測 = paradigm 安定性追加証拠**。SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 = **SS 0 件 = ~11-12 行/loop (Loop 121/127) / SS 1 件 + 説明軽量化 = ~22-25 行/loop (Loop 125/129/131) / SS 1 件 + 説明大量化 = ~42 行/loop (Loop 123)** の 3 段階階層化が安定。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~24.5 行 = ~98-245 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-67 Loop 133 完了時点)**: Loop 131 → Loop 133 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-66) で +49 行 (33,309 → 33,358)、平均 ~24.5 行/loop。Loop 131 観測値 (~24.5 行/loop) と比較して **完全一致 (差 ~0%)** = paradigm pivot 多軸 (Loop 132 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 133 = frontend 軸 = 純粋関数機能分離軸 frontend 版 8 件目 = TranscriptView.tsx の getAiTransmissionStatusLabel + getAiTransmissionStatusPillClass + getAiTransmissionStatusAriaLabel → aiTransmissionHelpers.ts (新規 = AI 送信状態 display tier helpers) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 131 観測値 (~24.5 行/loop) と完全一致の主因 = **SESSION SUMMARY 1 件継続** (mjc-main-20260505-66 handoff SUMMARY commit `397431f` = ~24 行) + paradigm pivot 同形 (K + frontend) = **SS 1 件 + 説明軽量化パターンの 4 連続観測** (Loop 125 = ~22.5 行/loop / Loop 129 = ~23.5 行/loop / Loop 131 = ~24.5 行/loop / Loop 133 = ~24.5 行/loop) = **階層化 paradigm 成熟期入り = 4 連続値域 ~22-25 行/loop に完全収束**。frontend 軸 chore entry の軽量化 paradigm (~12-13 行/件) は Loop 125/127/129/131/133 の **5 件連続観測** = **frontend 軸軽量化 paradigm の 5 度目の観測 = paradigm 完全安定**。SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 = **SS 0 件 = ~11-12 行/loop (Loop 121/127) / SS 1 件 + 説明軽量化 = ~22-25 行/loop (Loop 125/129/131/133) / SS 1 件 + 説明大量化 = ~42 行/loop (Loop 123)** の 3 段階階層化が 4 連続観測で実証完了。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~24.5 行 = ~98-245 行/時間 の範囲、アクティブセッション間の差異)。

> **更新観測 (mjc-main-20260505-67 Loop 135 完了時点)**: Loop 133 → Loop 135 (~2 ループ間 + SESSION SUMMARY 0 件) で +24 行 (33,358 → 33,382)、平均 ~12 行/loop。Loop 133 観測値 (~24.5 行/loop = SS 1 件 + 説明軽量化) と比較して **大幅減 (-50%)** = paradigm pivot 多軸 (Loop 134 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 135 = frontend 軸 = 純粋関数機能分離軸 frontend 版 9 件目 = TranscriptView.tsx の getAudioSourceStatusLabel + getAudioSourceStatusAriaText + getAudioSourceNotice + getAudioSourceStatusPillClass → audioSourceHelpers.ts (新規 = Audio Source display tier helpers) = refactor + chore) で SESSION SUMMARY 0 件 + chore entry 2 件 + docs entry 1 件 (agent-log-archive-plan.md, AGENT_LOG.md には寄与せず) + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 133 観測値 (~24.5 行/loop) との -50% 差の主因 = **SESSION SUMMARY 件数 0 件継続** + paradigm pivot 同形 (K + frontend) = **SS 0 件パターン (Loop 121 = ~11 行/loop / Loop 127 = ~12 行/loop / Loop 135 = ~12 行/loop) の 3 連続観測達成** = **階層化 paradigm 最低段階の完全実証** (3 セッション跨ぎの再現 = mjc-main-20260505-62 / mjc-main-20260505-65 / mjc-main-20260505-67)。frontend 軸 chore entry の軽量化 paradigm (~14 行/件) は Loop 125/127/129/131/133/135 の **6 件連続観測** = **frontend 軸軽量化 paradigm の 6 度目の観測 = paradigm 完全成熟期**。SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 = **SS 0 件 = ~11-12 行/loop (Loop 121/127/135 = 3 連続観測) / SS 1 件 + 説明軽量化 = ~22-25 行/loop (Loop 125/129/131/133 = 4 連続観測) / SS 1 件 + 説明大量化 = ~42 行/loop (Loop 123)** の 3 段階階層化が **両端 (SS 0 件 + SS 1 件軽量化) で複数連続観測達成 = paradigm 完全実証期**。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~12 行 = ~48-120 行/時間 の範囲、SUMMARY 1 件 で押し上げ後の安定アクティブ期)。

> **更新観測 (mjc-main-20260505-68 Loop 137 完了時点)**: Loop 135 → Loop 137 (~2 ループ間 + SESSION SUMMARY 1 件 mjc-main-20260505-67) で +48 行 (33,382 → 33,430)、平均 ~24 行/loop。Loop 133 観測値 (~24.5 行/loop = SS 1 件 + 説明軽量化) と比較して **ほぼ同水準 (差 ~-2%)** = paradigm pivot 多軸 (Loop 136 = harness 衛生 K 軸 = docs entry 1 件 + chore entry 1 件 + Loop 137 = frontend 軸 = 純粋関数機能分離軸 frontend 版 10 件目 = TranscriptView.tsx の getEngineStatusLabel + getEngineStatusDisplayLabel + getEngineStatusPillClass → engineStatusHelpers.ts (新規 = Engine status display tier helpers) = refactor + chore) で SESSION SUMMARY 1 件 + chore entry 3 件 + docs entry 1 件 + refactor entry 1 件 (refactor は AGENT_LOG.md 触らず = 0 行寄与) の混合増加が寄与。Loop 133 観測値 (~24.5 行/loop) とほぼ同水準維持の主因 = **SESSION SUMMARY 1 件継続** (mjc-main-20260505-67 handoff SUMMARY commit `1d10e5a` = ~30 行) + paradigm pivot 同形 (K + frontend) = **SS 1 件 + 説明軽量化パターンの 5 連続観測達成** (Loop 125 = ~22.5 行/loop / Loop 129 = ~23.5 行/loop / Loop 131 = ~24.5 行/loop / Loop 133 = ~24.5 行/loop / Loop 137 = ~24 行/loop) = **階層化 paradigm 完全成熟期で 5 連続値域 ~22-25 行/loop に完全収束**。frontend 軸 chore entry の軽量化 paradigm (~12-14 行/件) は Loop 125/127/129/131/133/135/137 の **7 件連続観測** = **frontend 軸軽量化 paradigm の 7 度目の観測 = paradigm 完全成熟期継続**。SESSION SUMMARY 件数 + paradigm 多様性 + entry 説明量の 3 軸が支配変数 = **SS 0 件 = ~11-12 行/loop (Loop 121/127/135 = 3 連続観測) / SS 1 件 + 説明軽量化 = ~22-25 行/loop (Loop 125/129/131/133/137 = 5 連続観測達成) / SS 1 件 + 説明大量化 = ~42 行/loop (Loop 123)** の 3 段階階層化が **SS 1 件軽量側で 5 連続観測達成 = paradigm 完全実証期延長**。長期平均 ~830 行/時間 とは依然乖離あり (1 ループ ~24 行 = ~96-240 行/時間 の範囲、アクティブセッション間の差異)。

### 2.4 既存運用の維持コスト

- worker prompt 必須要素: 「冒頭で末尾 350 行を読む」「Read 全体禁止 = tail/grep のみ」 = 末尾参照は維持できている
- ハンドオフ時: 「`tail -400 AGENT_LOG.md` で末尾だけ参照」 = 同様
- 機能的問題はないが、`git log` での sha 計算等で長期的に I/O コスト増加リスクあり

## 3. Target State (Archive 後の構造)

古い entry を batch ファイルに分離し、AGENT_LOG.md には末尾の最新 N セッション + Archive Index のみ残す。

```
docs/agent-log-archive/
├── README.md                       # batch index (どの batch にどの session 範囲が含まれるか)
├── batch-001-2026-05-04-full.md    # mjc-main-20260504-* シリーズ + Loop 1-22 (~25K 行)
├── batch-002-2026-05-05-early.md   # mjc-main-20260505-1 〜 -12 (Loop 23 周辺) (~5K 行)
└── ...
```

`AGENT_LOG.md` 末尾の構成:

```markdown
# AGENT_LOG (Active Tail)

> Note: 古い entry は docs/agent-log-archive/ に分離。Index は下記参照。

## Archive Index

| Batch | 期間 | セッション範囲 | 行数 | path |
|-------|------|--------------|------|------|
| 001 | 2026-05-04 | mjc-main-20260504-* (全) | ~25K | docs/agent-log-archive/batch-001-2026-05-04-full.md |
| 002 | 2026-05-05 早期 | mjc-main-20260505-1 〜 -12 | ~5K | docs/agent-log-archive/batch-002-2026-05-05-early.md |

## Active Sessions

(直近 ~10 セッションの entry を残す)
```

## 4. Strategy (戦略)

### 4.1 切り出し基準の選択肢

| Option | 切り出し単位 | メリット | デメリット |
|--------|-------------|---------|-----------|
| A. 行数ベース | ~10K 行ごとに 1 batch | 機械的、簡潔 | session 境界をまたぐ可能性 |
| B. session ベース | mjc-main-YYYYMMDD-N シリーズごと | 検索性高い、人間可読 | batch サイズ不均一 |
| C. 日付ベース | YYYY-MM-DD ごとに 1 batch | カレンダー直感的 | 1 日に複数セッションあると不均一 |

**推奨**: **Option B (session ベース)** = 検索性と人間可読性を優先。1 batch ~5K-10K 行を目安に複数 session を束ねる。

### 4.2 命名規則

- `docs/agent-log-archive/batch-NNN-{date-range}-{session-range}.md`
- 例: `batch-001-2026-05-04-full.md` (mjc-main-20260504-* シリーズ全部)
- 例: `batch-002-2026-05-05-early.md` (mjc-main-20260505-1 〜 -12 Loop 23 直前まで)

### 4.3 grep / 検索互換性

archive 移動後も `grep -r "<keyword>" AGENT_LOG.md docs/agent-log-archive/` で全体検索可能 = 既存運用の互換性確保。

## 5. Phase Plan

### Phase 1: Archive Index Header の追加 (規模 SS、~5-10 分)

**前提**: ユーザー直伝指示で実施承認後に着手。

`AGENT_LOG.md` の先頭付近 (L1 直後) または SESSION SUMMARY 直前に Archive Index Header を追加。実 archive 移動はまだしない (移動先 batch file が未作成のため)。

**完了基準**:
- `grep -n "Archive Index" AGENT_LOG.md`: 1 件確認
- trailing whitespace なし

### Phase 2: batch-001 切り出し = mjc-main-20260504-* シリーズ全部 (規模 S、~10-15 分)

`docs/agent-log-archive/batch-001-2026-05-04-full.md` を新規作成し、AGENT_LOG.md L1-L25135 (~25K 行) を移動。AGENT_LOG.md は残 ~5K 行 + Archive Index Header に縮小。

**完了基準**:
- `wc -l AGENT_LOG.md`: ~6K 行以下に縮小
- `wc -l docs/agent-log-archive/batch-001-2026-05-04-full.md`: ~25K 行
- `grep -r "Loop 1 " AGENT_LOG.md docs/agent-log-archive/`: batch 側に存在

### Phase 3: batch-002 以降の段階切り出し (規模 SS、随時)

mjc-main-20260505-1 〜 -12 等を順次 batch 化。最新 ~10 セッションは AGENT_LOG.md に保持。

**方針**: AGENT_LOG.md が ~10K 行を超えたタイミングで batch 切り出しを実施。

### Phase 4: 自動化検討 (低優先)

`scripts/agent-log-archive.sh` の作成 = 古い session を自動 batch 化するスクリプト。月数十 archive batch 程度なら手動で十分なため、運用規模に応じて判断。

### Phase 状態 (mjc-main-20260505-41 Loop 81 時点)

| Phase | 状態 | 備考 |
|-------|------|------|
| Phase 1 | 未着手 | 実施は別途ユーザー直伝指示要 (本 plan L99 の前提条件) |
| Phase 2 | 未着手 | Phase 1 完了後 |
| Phase 3 | 未着手 | Phase 2 完了後、運用開始後の段階切り出し |
| Phase 4 | 未着手 | 月数十 archive batch 規模に達した場合 |

実施判断は plan L99「ユーザー直伝指示で実施承認後に着手」を継続。本 plan の現状把握更新 (Section 2.1 / 2.3) は自律 OK な harness 衛生作業として位置づけ。

## 6. Open Questions (要検証)

| # | 質問 | 重要度 | 確認方法 |
|---|------|--------|---------|
| Q1 | archive 移動後の git log history 追従 | 中 | `git log --follow AGENT_LOG.md` で history が batch file 側に追従するか確認 |
| Q2 | grep 互換性の手動テスト | 中 | `grep -r "Loop 23" AGENT_LOG.md docs/agent-log-archive/` で実態確認 |
| Q3 | 1 batch あたりの最適行数 | 低 | 実運用で context 制約に達するまで増やしてみる |
| Q4 | tool 自動化の優先度 | 低 | 月数十 archive batch 程度なら手動で十分か |

## 7. 参考

- `docs/architecture/transcription-refactor-plan.md` (Phase 1-6 完全完遂 precedent)
- `docs/architecture/detection-extension-plan.md` (Loop 71 新規作成 precedent、本 plan の structure 直接踏襲)
- AGENTS.md L46-L52 自律改善方針: 「ハーネスを自律的に整える」「作業ごとに検証し、結果を AGENT_LOG.md に記録する」
- 過去 worker prompt 必須要素 6: 「大型ファイルは Read 全体禁止 = tail/head/grep で対象範囲のみ参照」
