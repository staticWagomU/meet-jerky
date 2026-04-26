# Agent Harness

## 目的

自律改善を安全・継続的に回すために、tmux上のCodexセッションを起動、監視、指示、再起動、引き継ぎできる運用を整える。

ハーネスはメインエージェントの判断を補助するためのものであり、判断責任を完全にスクリプトへ丸投げしない。

## セッション方針

- 作業用Codexセッションは `tmux new-session` で起動する。
- 呼び出すCodexのモデルは `gpt-5.5` を指定する。
- reasoning level は `medium` または `low` を指定する。
- 調査、軽い監視、ログ整理は `low` を優先する。
- 実装、レビュー、設計判断を含む作業は `medium` を優先する。
- モデルやreasoning levelを指定できない環境では、指定を試みた事実と失敗理由を `AGENT_LOG.md` に記録し、利用可能な方法で継続する。

## 役割

### メインエージェント

- 作業分解
- tmuxセッション起動
- pane出力監視
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

### 作業担当エージェント

- 指定されたファイルまたは機能範囲のみコード変更可能
- 他エージェントの変更を戻さない
- 実装後に妥当な検証を実行する
- 変更内容、変更ファイル、検証結果、残リスクを報告する

## ログ方針

各タスクについて、以下を `AGENT_LOG.md` に記録する。

- 開始日時
- 担当セッション
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

## 最小PoC

1. 現在のgit状態、プロジェクト構成、検証コマンドを確認する。
2. `AGENT_LOG.md` を更新する。
3. 調査担当セッションを1つ以上起動する。
4. pane出力を確認し、改善候補を小さな作業単位に分解する。
5. 競合しない範囲で作業担当セッションを起動する。
6. 結果を統合レビューする。
7. 検証する。
8. 問題がなければ `main` にコミットする。
9. 次の改善ループへ進む。

## 最小補助スクリプト

以下のスクリプトは、メインエージェントの判断を補助する薄いラッパーとして使う。
判断責任をスクリプトへ丸投げせず、差分レビュー、検証結果の解釈、コミット可否判断はメインエージェントが行う。

- `scripts/agent-start-research.sh SESSION PROMPT_FILE [OUTPUT_FILE]`
  - 調査担当を `tmux new-session` と `codex exec` で起動する。
  - reasoning level は `low`。
  - `-o` で最終出力を `logs/agent/<SESSION>.txt` に保存する。
- `scripts/agent-start-worker.sh SESSION PROMPT_FILE [OUTPUT_FILE]`
  - 作業担当を `tmux new-session` と `codex exec` で起動する。
  - reasoning level は `medium`。
  - `-o` で最終出力を保存する。
- `scripts/agent-tail-output.sh SESSION [LINES]`
  - 保存済み最終出力と、実行中なら tmux pane 出力を確認する。
- `scripts/agent-watch.sh [PREFIX]`
  - git状態、tmuxセッション、保存済み出力ファイルを一覧する。
- `scripts/agent-verify.sh [PATH ...]`
  - `git diff --check` と `npm run build` を実行する。
  - `cmake` がある場合のみ `cargo test --manifest-path src-tauri/Cargo.toml` を実行する。
  - `cmake` が無い環境では `whisper-rs-sys` がビルドできないため Rust 全体テストを skip する。
- `scripts/agent-commit.sh COMMIT_MESSAGE [PATH ...]`
  - コミット前の status と diff stat を表示し、指定 path を stage してコミットする。
  - path 未指定時は tracked file の変更だけを stage する。
- `scripts/agent-handoff-main.sh SESSION PROMPT_FILE [OUTPUT_FILE]`
  - 後継メインエージェントを `tmux new-session` で起動する。
  - 後継プロンプトは `PROMPT_FILE` に具体的な引き継ぎ内容を書いて渡す。
- `scripts/agent-adopt-main.sh SUCCESSOR_SESSION [MAIN_SESSION]`
  - 後継メインエージェントを watchdog が監視する canonical 名へ切り替える。
  - 標準では既存の `mj-main` を一時退避して終了し、`SUCCESSOR_SESSION` を `mj-main` にリネームする。
  - 後継が十分に起動し、旧メインが引き継ぎ以外の作業を増やさない状態で実行する。
- `scripts/agent-watchdog.sh [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS] [NUDGE_COOLDOWN_SECONDS]`
  - メインセッションが存在するかを定期確認し、存在しなければ `agent-handoff-main.sh` で起動する。
  - メインセッションが入力待ちに見える場合、定型の継続指示だけを送る。
  - 判断・実装・差分修正・検証解釈・コミットは行わない。
  - 標準では `mj-main` を `docs/autonomous-main-prompt.md` で起動し、600秒間隔で確認する。
  - 継続指示は `docs/autonomous-main-prompt.md` へ戻す nudge に限定し、改善対象の判断、差分修正、検証解釈、コミット判断は行わない。
  - 標準の nudge cooldown は600秒。`MJ_WATCHDOG_NUDGE_COOLDOWN_SECONDS` で上書きできる。
- `scripts/agent-start-watchdog.sh [WATCHDOG_SESSION] [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS] [NUDGE_COOLDOWN_SECONDS]`
  - watchdog 自体を `tmux new-session` で起動する。
  - 標準では `mj-watchdog` セッションを起動する。

## 初回起動

人間が10分ごとに確認する代わりに watchdog を使う場合は、最初のCodexセッションに `docs/autonomous-start-prompt.md` の内容を流す。
このプロンプトは `mj-watchdog` を起動し、watchdog が `mj-main` を維持する状態を作る。

## 引き継ぎ

メインエージェントのコンテキストが多くなってきたと近似判断したら、止まる前に後継メインエージェントを起動する。

後継メインエージェントには、目的、進行中セッション、未完了タスク、直近の判断、参照すべきログ、停止すべき旧メインセッションを明確に伝える。

後継メインエージェントへ引き継いだら、`scripts/agent-adopt-main.sh 後継セッション名 mj-main` で watchdog の監視対象名を後継へ移し、旧メインエージェントを終了する。メインエージェントを増殖させない。
