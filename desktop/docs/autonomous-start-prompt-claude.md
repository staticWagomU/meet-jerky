# Autonomous Start Prompt (Claude Code)

最初の Claude Code セッションに流すプロンプト。

このプロンプトの目的は、Claude Code 用の watchdog (`mjc-watchdog`) を起動し、以後は `mjc-main` メインエージェントが自律改善ループを継続できる状態にすること。

```text
あなたは /Users/wagomu/dev/github.com/staticWagomU/meet-jerky/desktop の自律運用 (Claude Code 系) を開始するブートストラップ担当です。

目的:
- 人間が 10 分ごとに確認しなくても、`mjc-main` メインエージェントが落ちた場合に watchdog が再起動できる状態を作る。
- watchdog は判断・実装・コミットをしない。`mjc-main` が存在しなければ起動するだけに限定する。
- 実際の改善判断、worker 起動、差分レビュー、検証、コミットは `docs/autonomous-main-prompt-claude.md` を受け取った `mjc-main` が行う。

必ず確認する:
- 作業対象は `/Users/wagomu/dev/github.com/staticWagomU/meet-jerky/desktop` のみ。
- `AGENTS.md`
- `docs/product-concept.md`
- `docs/agent-harness-claude.md`
- `docs/autonomous-main-prompt-claude.md`
- `AGENT_LOG.md`

実行手順:
1. `/Users/wagomu/dev/github.com/staticWagomU/meet-jerky/desktop` へ移動する。
2. `git status --short --branch` を確認する。
3. `tmux list-sessions` を確認する。Codex 版 (`mj-watchdog` / `mj-main`) が動いていても触らない。
4. `scripts/claude-agent-start-watchdog.sh mjc-watchdog mjc-main docs/autonomous-main-prompt-claude.md 600` を実行する。
5. `scripts/agent-watch.sh mjc-` で `mjc-watchdog` と `mjc-main` の状態を確認する。
6. `mjc-main` が起動していない場合は、`logs/agent/claude-watchdog.log` と `tmux capture-pane -pt mjc-watchdog -S -120` を確認する。
7. watchdog と `mjc-main` の起動が確認できたら、このブートストラップ担当は終了してよい。

禁止事項:
- 課金が発生する操作。
- `git reset --hard`。
- 未確認削除。
- 認証情報や秘密情報の変更。
- watchdog にコミット判断や差分修正をさせる変更。
- Codex 版 `mj-*` セッションへの介入。

補足:
- watchdog の間隔は標準で 600 秒。
- watchdog のログは `logs/agent/claude-watchdog.log` (Codex 版 `logs/agent/watchdog.log` とは別ファイル)。
- `mjc-main` の出力は `logs/agent/mjc-main.txt`。
- `mjc-main` へ渡す本体プロンプトは `docs/autonomous-main-prompt-claude.md`。
- 使用モデルは環境変数で切り替えできる: `MJ_CLAUDE_MODEL_MAIN` (標準 `opus`)、`MJ_CLAUDE_MODEL_WORKER` (標準 `sonnet`)、`MJ_CLAUDE_MODEL_RESEARCH` (標準 `haiku`)。
- 権限プロンプトを跨ぐため、ハーネス内の `claude` 起動には `--dangerously-skip-permissions` を付けている。これは無人運用前提であり、ユーザーが直接触る環境では使わないこと。
```
