# Agent Harness (Claude Code)

## 目的

`docs/agent-harness.md` の Codex 版と同じ運用思想を、Claude Code (`claude` CLI) で動かすためのハーネス。tmux 上の Claude Code セッションを起動、監視、指示、再起動、引き継ぎできるようにする。

ハーネスはメインエージェントの判断を補助するためのものであり、判断責任を完全にスクリプトへ丸投げしない。

Codex 版 (`mj-*` セッション群) と Claude Code 版 (`mjc-*` セッション群) は同時に共存できるが、同じファイルを編集する worker を両方の harness で同時起動しないこと。

## セッション方針

- 作業用 Claude Code セッションは `tmux new-session` で起動する。
- セッションプレフィックスは `mjc-` を使う (Codex の `mj-` と区別)。標準セッションは `mjc-main` と `mjc-watchdog`。
- 呼び出すモデルは役割に応じて分ける。
  - 調査担当: `haiku` (`MJ_CLAUDE_MODEL_RESEARCH` で上書き可)
  - 作業担当: `sonnet` (`MJ_CLAUDE_MODEL_WORKER` で上書き可)
  - メイン: `opus` (`MJ_CLAUDE_MODEL_MAIN` で上書き可)
- Codex の `model_reasoning_effort` に対応する概念は Claude Code には無い。代わりにモデル選択 (haiku/sonnet/opus) で重さを調整する。
- 権限ダイアログを止めるため、ハーネス内では `--dangerously-skip-permissions` を使う。これは自動運用前提であり、ユーザーが直接触る環境では使わない。
- モデルを指定できない、または指定モデルが利用できない環境では、その事実と失敗理由を `AGENT_LOG.md` に記録し、利用可能なモデルで継続する。

## 役割

### メインエージェント (`mjc-main`)

- 作業分解
- tmux セッション起動
- pane 出力監視
- 作業指示
- 競合回避
- 差分レビュー
- 検証
- コミット
- `AGENT_LOG.md` 更新
- コンテキスト肥大時の後継メインエージェント起動と旧メイン終了指示

### 調査担当エージェント

- コード変更禁止
- 調査、設計、リスク整理、改善提案のみ行う
- 実装可能で価値が高い改善候補を報告する
- `claude -p` (print mode) で起動するため、応答後はセッションが自然終了する

### 作業担当エージェント

- 指定されたファイルまたは機能範囲のみコード変更可能
- 他エージェントの変更を戻さない
- 実装後に妥当な検証を実行する
- 変更内容、変更ファイル、検証結果、残リスクを報告する
- `claude -p` で起動するため、1 回の応答で目的を達成できる粒度のタスクを渡す

## ログ方針

各タスクについて、以下を `AGENT_LOG.md` に記録する。

- 開始日時
- 担当セッション (例: `mjc-research-001`, `mjc-worker-permissions`)
- 役割
- 作業範囲
- 指示内容
- 結果
- 変更ファイル
- 検証結果
- 依存関係追加の有無と理由
- 失敗理由
- 次アクション

## 禁止事項

- 課金が発生する操作
- `git reset --hard`
- 未確認の破壊的削除
- 認証情報や秘密情報の変更
- 担当範囲外の同時編集
- 録音・文字起こしのステルス動作を前提にした実装
- `--dangerously-skip-permissions` を人手運用シェル内で使用すること

## 最小 PoC

1. 現在の git 状態、プロジェクト構成、検証コマンドを確認する。
2. `AGENT_LOG.md` を更新する。
3. 調査担当セッションを 1 つ以上起動する (`claude-agent-start-research.sh`)。
4. pane 出力 / 出力ファイルを確認し、改善候補を小さな作業単位に分解する。
5. 競合しない範囲で作業担当セッションを起動する (`claude-agent-start-worker.sh`)。
6. 結果を統合レビューする。
7. 検証する (`agent-verify.sh`)。
8. 問題がなければ `main` にコミットする (`agent-commit.sh`)。
9. 次の改善ループへ進む。

## 最小補助スクリプト

Claude Code 専用スクリプトは `scripts/claude-agent-*.sh`。検証・コミット・出力閲覧・セッション一覧などプロセス共通の操作は、Codex 版と同じ `scripts/agent-*.sh` をそのまま使う。

Claude Code 専用 (新規作成):

- `scripts/claude-agent-start-research.sh SESSION PROMPT_FILE [OUTPUT_FILE]`
  - 調査担当を `tmux new-session` と `claude -p` で起動する。
  - モデルは `MJ_CLAUDE_MODEL_RESEARCH` (標準 `haiku`)。
  - 出力は `logs/agent/<SESSION>.txt` に保存する。
- `scripts/claude-agent-start-worker.sh SESSION PROMPT_FILE [OUTPUT_FILE]`
  - 作業担当を `tmux new-session` と `claude -p` で起動する。
  - モデルは `MJ_CLAUDE_MODEL_WORKER` (標準 `sonnet`)。
- `scripts/claude-agent-handoff-main.sh SESSION PROMPT_FILE [OUTPUT_FILE]`
  - 後継メインエージェントを `tmux new-session` と対話モードの `claude` で起動する。
  - モデルは `MJ_CLAUDE_MODEL_MAIN` (標準 `opus`)。
  - 後継プロンプトは `PROMPT_FILE` に具体的な引き継ぎ内容を書いて渡す。
- `scripts/claude-agent-watchdog.sh [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS] [NUDGE_COOLDOWN_SECONDS]`
  - メインセッションが存在するかを定期確認し、存在しなければ `claude-agent-handoff-main.sh` で起動する。
  - メインセッションが入力待ちに見える場合、定型の継続指示だけを送る。
  - idle 判定は Claude Code TUI が生成中だけ表示する `esc to interrupt` の有無で行う。
  - 判断・実装・差分修正・検証解釈・コミットは行わない。
  - 標準では `mjc-main` を `docs/autonomous-main-prompt-claude.md` で起動し、600 秒間隔で確認する。
  - 標準の nudge cooldown は 600 秒。`MJ_WATCHDOG_NUDGE_COOLDOWN_SECONDS` で上書きできる。
- `scripts/claude-agent-start-watchdog.sh [WATCHDOG_SESSION] [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS] [NUDGE_COOLDOWN_SECONDS]`
  - watchdog 自体を `tmux new-session` で起動する。
  - 標準では `mjc-watchdog` セッションを起動する。

Codex 版と共通利用 (既存):

- `scripts/agent-tail-output.sh SESSION [LINES]` — 出力ファイル + tmux pane の確認。
- `scripts/agent-watch.sh [PREFIX]` — git 状態 / tmux セッション / 出力ファイル一覧。Claude Code を見るときは `scripts/agent-watch.sh mjc-` のように呼ぶ。
- `scripts/agent-verify.sh [PATH ...]` — `git diff --check`、フロントエンド build、`cargo fmt --check`、(cmake があれば) `cargo test` を順に実行する。
- `scripts/agent-commit.sh COMMIT_MESSAGE [PATH ...]` — 指定 path を stage してコミットする。
- `scripts/agent-adopt-main.sh SUCCESSOR_SESSION [MAIN_SESSION]` — 後継メインエージェントを canonical 名 (例 `mjc-main`) へ切り替える。`scripts/agent-adopt-main.sh mjc-main-YYYYMMDD-N mjc-main` のように Claude Code 用の名前を渡す。
- `scripts/agent-send-input.sh SESSION MESSAGE...` — 既存セッションへ追加プロンプトを送る (緊急時のみ。通常は watchdog の nudge に任せる)。

## 初回起動

人間が 10 分ごとに確認する代わりに watchdog を使う場合、最初の Claude Code セッションに `docs/autonomous-start-prompt-claude.md` の内容を流す。
このプロンプトは `mjc-watchdog` を起動し、watchdog が `mjc-main` を維持する状態を作る。

## 引き継ぎ

メインエージェントのコンテキストが多くなってきたと近似判断したら、止まる前に後継メインエージェントを起動する。

後継メインエージェントには、目的、進行中セッション、未完了タスク、直近の判断、参照すべきログ、停止すべき旧メインセッションを明確に伝える。

後継メインエージェントへ引き継いだら、`scripts/agent-adopt-main.sh 後継セッション名 mjc-main` で watchdog の監視対象名を後継へ移し、旧メインエージェントを終了する。メインエージェントを増殖させない。

## 環境変数

| 変数 | 標準値 | 用途 |
| --- | --- | --- |
| `MJ_ROOT_DIR` | リポジトリルート | スクリプトの作業対象ディレクトリ |
| `MJ_AGENT_OUTPUT_DIR` | `$ROOT/logs/agent` | 出力ファイル / watchdog ログ保存先 |
| `MJ_CLAUDE_MODEL_RESEARCH` | `haiku` | 調査担当の `claude --model` |
| `MJ_CLAUDE_MODEL_WORKER` | `sonnet` | 作業担当の `claude --model` |
| `MJ_CLAUDE_MODEL_MAIN` | `opus` | メイン / 後継メインの `claude --model` |
| `MJ_CLAUDE_WATCHDOG_LOG` | `$ROOT/logs/agent/claude-watchdog.log` | Claude 用 watchdog ログ |
| `MJ_CLAUDE_WATCHDOG_NUDGE_MESSAGE` | 標準文 | idle 時に送る継続指示 |
| `MJ_WATCHDOG_NUDGE_COOLDOWN_SECONDS` | `600` | nudge 連打抑止のクールダウン秒数 |
