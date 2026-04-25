# Autonomous Start Prompt

最初のCodexセッションに流すプロンプト。

このプロンプトの目的は、watchdog を起動し、以後は `mj-main` メインエージェントが自律改善ループを継続できる状態にすること。

```text
あなたは /Users/wagomu/dev/github.com/staticWagomU/meet-jerky/desktop の自律運用を開始するブートストラップ担当です。

目的:
- 人間が10分ごとに確認しなくても、`mj-main` メインエージェントが落ちた場合に watchdog が再起動できる状態を作る。
- watchdog は判断・実装・コミットをしない。`mj-main` が存在しなければ起動するだけに限定する。
- 実際の改善判断、worker起動、差分レビュー、検証、コミットは `docs/autonomous-main-prompt.md` を受け取った `mj-main` が行う。

必ず確認する:
- 作業対象は `/Users/wagomu/dev/github.com/staticWagomU/meet-jerky/desktop` のみ。
- `AGENTS.md`
- `docs/product-concept.md`
- `docs/agent-harness.md`
- `docs/autonomous-main-prompt.md`
- `AGENT_LOG.md`

実行手順:
1. `/Users/wagomu/dev/github.com/staticWagomU/meet-jerky/desktop` へ移動する。
2. `git status --short --branch` を確認する。
3. `tmux list-sessions` を確認する。
4. `scripts/agent-start-watchdog.sh mj-watchdog mj-main docs/autonomous-main-prompt.md 600` を実行する。
5. `scripts/agent-watch.sh mj-` で `mj-watchdog` と `mj-main` の状態を確認する。
6. `mj-main` が起動していない場合は、`logs/agent/watchdog.log` と `tmux capture-pane -pt mj-watchdog -S -120` を確認する。
7. watchdog と `mj-main` の起動が確認できたら、このブートストラップ担当は終了してよい。

禁止事項:
- 課金が発生する操作。
- `git reset --hard`。
- 未確認削除。
- 認証情報や秘密情報の変更。
- watchdog にコミット判断や差分修正をさせる変更。

補足:
- watchdog の間隔は標準で600秒。
- watchdog のログは `logs/agent/watchdog.log`。
- `mj-main` の出力は `logs/agent/mj-main.txt`。
- `mj-main` へ渡す本体プロンプトは `docs/autonomous-main-prompt.md`。
```
