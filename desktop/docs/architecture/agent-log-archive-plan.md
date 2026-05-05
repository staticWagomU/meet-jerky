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
