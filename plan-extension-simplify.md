# 拡張機能スリム化 + AI再設計 計画

> 対象: ルートのChrome拡張のみ（`desktop/` は対象外）。既存 `plan.md` はデスクトップ版計画のため別ファイルとした。

## 決定事項（2026-07-07 ユーザー確認済み）

1. **削除**: Google Docsエクスポート・Google連携（OAuth/identity）、議事録テンプレート、MD/JSON/TXT/RAWファイルダウンロード
2. **AIプロバイダ**: OpenAIのみに絞る（Anthropic/Gemini削除）
3. **コピー統合**: 詳細画面の取り出し口は「全文コピー」1ボタン = RAW生ログをクリップボードへ（ファイルDL全廃）
4. **AI機能はサイドパネル専用に移動**: AI要約 + メモ欄 + 新規チャット機能（文字起こしへの質問）

## 実装ステップ

### Step 1: 依存の削除（Tidy）
- [x] `utils/google-auth.ts` / `utils/google-docs.ts` / `utils/template.ts` とテスト3本を削除
- [x] `wxt.config.ts`: `identity` パーミッション、`oauth2`、docs/anthropic/gemini の `host_permissions` を削除

### Step 2: データモデル + 設定（TDD）
- [x] `utils/types.ts`: `AIProvider`・`UserSettings.google`・`UserSettings.template` を削除。`ai` は `{ apiKey, model, customPrompt }` に
- [x] `utils/settings.ts`: 新デフォルト値。旧設定（provider が anthropic/gemini）が保存されている場合は `apiKey`/`model` をリセットする移行処理
- [x] `utils/__tests__/settings.test.ts` を新仕様で書き直し（RED→GREEN）

### Step 3: ai-client の OpenAI 特化 + チャット（TDD）
- [x] `summarizeTranscript(apiKey, prompt, transcriptText, model, memo?)` — provider引数削除
- [x] `chatAboutTranscript(apiKey, model, transcriptText, messages)` — 文字起こしをsystemコンテキストに含めたチャット補完（新規）
- [x] `utils/__tests__/ai-client.test.ts` 書き直し

### Step 4: helpers の整理
- [x] `formatSessionAsMarkdown` / `formatSessionAsJson` / `buildExportFilename` を削除（テストも）
- [x] `formatTranscriptAsText`（AIコンテキスト用）と `formatRawTranscriptAsText`（コピー用）は残す

### Step 5: UI
- [x] `options/main.ts`: Google連携カード・テンプレートカード削除。AIカードは APIキー + モデル名 + 要約プロンプト のみに
- [x] `popup/main.ts`:
  - ツールバーを「全文コピー」1ボタンに（RAW生ログをコピー、rawTranscript空の旧セッションは整形済みテキストにフォールバック）
  - AI要約・メモ・チャットUIは `IS_SIDE_PANEL` のときだけ詳細画面に描画
  - popup側にはサイドパネル誘導のみ（既存の「サイドパネルで開く」ボタン）
- [x] チャットUI: メッセージリスト + 入力欄。会話履歴は詳細画面表示中のみ保持（永続化しない）
- [x] CSS: 不要クラス削除、チャット用スタイル追加

### Step 6: ドキュメント + 検証
- [x] README更新: 機能一覧から各種エクスポートを削除。「AI機能使用時のみOpenAIに文字起こしが送信される」旨を明記（現状の「外部送信なし」宣言と矛盾していたため）
- [x] `npm test` / `npm run compile` / `npm run lint` / `npm run build` 全通過
