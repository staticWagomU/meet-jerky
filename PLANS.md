# ミートジャーキー - 実装計画

## 概要

Google Meet の字幕（キャプション）機能を活用し、ミーティング中の文字起こしを自動的に取得・保存するChrome拡張機能。

## 要件

1. Google Meet のルームに入った際に字幕機能を自動的にオンにする
2. 字幕テキストを MutationObserver でリアルタイムに捕捉し、5分ごとに `chrome.storage.local` へ永続化する
3. 字幕パネルの表示領域を非表示にする（トグルで表示/非表示を切り替え可能）
4. 退室・タブ閉じ・ページ遷移時に未保存データの最終フラッシュを best effort で実施する
5. 取得した文字起こしデータを拡張機能のポップアップから閲覧できるようにする
6. 保存データは直近10件のセッションを保持する（暫定ルール。容量問題が発生したら見直す）

---

## 調査結果

### 参考プロジェクト

| プロジェクト | URL | 特徴 |
|---|---|---|
| TranscripTonic | https://github.com/vivek-nexus/transcriptonic | 最も活発にメンテナンスされている。`aria-label`/`role`ベースの安定セレクタ |
| Recall.ai Chrome Extension | https://github.com/recallai/chrome-recording-transcription-extension | TypeScript実装。`scrapingScript.ts`が参考になる |
| Meet-Script | https://github.com/RutvijDv/Meet-Script | シンプルな実装。jscontrollerベースのセレクタ |
| alert-me-google-meet | https://github.com/heytulsiprasad/alert-me-google-meet | キーワードアラート。キャプション監視の参考 |

### Google Meet DOM構造（調査時点の事実）

**Shadow DOM/iframe**: Google Meetはキャプション要素にShadow DOMやiframeを使用していない。すべてlight DOMに直接レンダリングされるため、Content Scriptから `document.querySelector` で直接アクセス可能。

#### 字幕ボタン

| 方法 | 実装 | 安定性 |
|---|---|---|
| Material Iconsテキスト検索 | `.google-symbols` 内 `closed_caption_off` テキスト → `.click()` | 安定 |
| aria-label | `button[aria-label="Turn on captions"]` / `button[aria-label="字幕をオンにする"]` | 言語依存 |
| キーボードショートカット | `Shift+C` で切り替え | Content Scriptからの合成イベントでは動作しない可能性あり |

#### 字幕テキスト領域

| セレクタ | 用途 | 出典 |
|---|---|---|
| `div[role="region"][aria-label="Captions"]` | キャプション領域全体（安定） | Recall.ai |
| `div[role="region"][tabindex="0"]` | キャプション領域全体（代替） | TranscripTonic |

#### キャプションDOMの階層構造（参考情報・難読化クラスのため不安定）

```
div[role="region"][aria-label="Captions"]  ← キャプション領域全体
  └── div.nMcdL (キャプション行コンテナ)
        ├── [発言者名要素] .NWpY1d  ← textContentで名前を取得
        └── [テキスト要素] .ygicle  ← textContentでキャプションテキストを取得
```

**注意**: `.nMcdL`, `.ygicle`, `.NWpY1d` 等の難読化クラス名はGoogleのUIアップデートで頻繁に変更される。実装ではこれらに直接依存せず、DOM構造を走査して発言者名・テキストを取得する。

#### 退室ボタン

| 方法 | 実装 |
|---|---|
| Material Iconsテキスト検索 | `.google-symbols` 内 `call_end` テキスト → 親要素のボタンを取得 |
| aria-label | `button[aria-label="Leave call"]` / `button[aria-label="通話から退出"]` |

#### ミーティング中であることの検出

- `.google-symbols` 内の `call_end` テキストの出現でミーティング参加中と判定（TranscripTonic方式）

#### その他のUI要素

```javascript
// 会議タイトル
'.u6vdEc'
```

### 重複排除ロジック

Googleはキャプションを単語ごとに段階的に表示するため、重複排除が必須。

- **TranscripTonic方式**: `characterData` ミューテーションのみ処理。話者が変わった時にのみ前の話者のブロックを確定。テキスト長が250文字以上減少した場合はリセットと判断して分割
- **Recall.ai方式**: テキストを正規化（小文字化＋句読点除去）して比較。2秒間新テキストがなければチャンクを確定（commit）

### 既知の課題・注意点

- **DOM構造の変更**: Googleは定期的にMeetのUIを更新するため、セレクタが壊れる可能性がある
- **字幕精度**: 約90%。Google側でパラフレーズや切り詰めが行われることがある
- **言語依存**: `aria-label` の値はブラウザの言語設定に依存（`"Captions"` vs `"字幕"`）。初期実装は日本語UIのみ対応とし、多言語対応は残課題とする
- **2025年2月のUI更新**: キャプション履歴機能の追加により、DOM構造が変わっている可能性がある
- **2025年6月のUI更新**: キャプションスタイルカスタマイズ機能の追加
- **システムメッセージのフィルタリング**: `"you left the meeting"` 等のシステムメッセージを除外する必要がある
- **権限**: `activeTab`, `storage`, `alarms` 権限が必要

---

## 採用する設計

### セレクタ戦略

調査結果を踏まえ、以下の優先順位でセレクタを採用する。難読化クラス名には依存しない。

| 要素 | 主経路 | フォールバック |
|---|---|---|
| 字幕ボタン | `.google-symbols` 内 `closed_caption_off` テキスト → ボタン `.click()` | `button[aria-label*="caption"]` / `button[aria-label*="字幕"]` |
| 字幕領域 | `div[role="region"][aria-label="Captions"]` | `div[role="region"][tabindex="0"]` |
| 退室ボタン | `.google-symbols` 内 `call_end` テキスト → 親要素のボタン取得 | `button[aria-label*="Leave"]` / `button[aria-label*="退出"]` |
| 字幕テキスト | MutationObserver の `characterData` で変更検出 → DOM走査で発言者名・テキストを取得 | — |

### アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│ Content Script (entrypoints/content.ts)                 │
│  - Google Meet DOM 監視・操作                            │
│  - MutationObserver で字幕テキストをリアルタイム取得       │
│  - TranscriptBlock 確定時に Background へ増分送信        │
│  - 字幕パネルの表示/非表示制御                            │
│  - 退室ボタン・タブ閉じ時の最終フラッシュ                  │
├─────────────────────────────────────────────────────────┤
│ Background Script (entrypoints/background.ts)           │
│  - chrome.alarms で5分タイマー → storage へ永続化        │
│  - Content Script からの増分データ受信・バッファ管理       │
│  - chrome.tabs.onRemoved でタブ閉じ時の最終保存           │
│  - chrome.storage.local でデータ永続化                   │
├─────────────────────────────────────────────────────────┤
│ Popup UI (entrypoints/popup/)                           │
│  - セッション一覧表示                                    │
│  - 文字起こしデータの閲覧                                │
│  - データ削除・テキストコピー機能                          │
└─────────────────────────────────────────────────────────┘
```

### メッセージング（Content Script ↔ Background）

| メッセージ | 方向 | 用途 |
|---|---|---|
| `MEETING_STARTED` | Content → Background | セッション開始。meetingCode, タイトル, 開始時刻を送信 |
| `TRANSCRIPT_UPDATE` | Content → Background | TranscriptBlock 確定時に増分送信 |
| `MEETING_ENDED` | Content → Background | セッション終了。最終フラッシュ |
| `GET_SESSIONS` | Popup → Background | 保存済みセッション一覧を取得 |
| `GET_TRANSCRIPT` | Popup → Background | 指定セッションの文字起こしデータを取得 |
| `DELETE_SESSION` | Popup → Background | 指定セッションを削除 |

### データモデル

```typescript
interface TranscriptBlock {
  personName: string;      // 話者名
  timestamp: string;       // ISO 8601 タイムスタンプ
  transcriptText: string;  // 文字起こしテキスト
}

interface MeetingSession {
  sessionId: string;           // ユニークID（生成）
  meetingCode: string;         // Google Meet の会議コード（URLから取得）
  meetingTitle: string;        // ミーティングタイトル
  startTimestamp: string;      // セッション開始日時
  endTimestamp: string;        // セッション終了日時
  transcript: TranscriptBlock[]; // 文字起こしデータ
}
```

### データフロー

```
[Google Meet DOM]
    │ MutationObserver（リアルタイム）
    ▼
[Content Script: メモリ上にバッファ]
    │ TranscriptBlock 確定時に即送信
    ▼
[Background Script: メモリ上にバッファ]
    │ chrome.alarms（5分ごと）or タブ閉じ時
    ▼
[chrome.storage.local: 永続化]
    │ GET_SESSIONS / GET_TRANSCRIPT
    ▼
[Popup UI: 閲覧]
```

---

## 実装フェーズ

### Phase 1: 基盤 + IPC + 保存スキーマ
- [x] WXT設定の更新（`matches` を `*://meet.google.com/*` に限定）
- [x] 既存 `entrypoints/content.ts` にミーティング開始検出を実装（`call_end` アイコンの出現を待つ）
- [x] `MeetingSession` / `TranscriptBlock` の型定義を作成
- [x] Content Script ↔ Background Script 間のメッセージング基盤を構築
- [x] Background Script に `chrome.storage.local` への保存・取得ロジックを実装
- [x] `chrome.alarms` で5分間隔タイマー設定

### Phase 2: 字幕検出 + リアルタイム取得
- [x] 字幕ボタンの検出とボタンクリックによる自動有効化
- [x] MutationObserver のセットアップ（2段階構造）
  - Body監視 → 字幕領域の出現を検出
  - 字幕領域監視 → テキスト変更を検出
- [x] 字幕テキストの重複排除ロジック
- [x] TranscriptBlock 確定時に Background へ増分送信

### Phase 3: 永続化 + 終了時保護
- [x] 5分タイマー発火時にバッファを `chrome.storage.local` へ永続化
- [x] 退室ボタンへの `click` イベントリスナー追加（`MEETING_ENDED` 送信）
- [x] タブ閉じ・ページ遷移時の best effort 保存（3層セーフティネット）
  - Content Script: `visibilitychange` イベント（`hidden` 時に最終フラッシュ）
  - Content Script: `beforeunload` イベント（フォールバック）
  - Background Script: `chrome.tabs.onRemoved` で未保存データを最終保存
- [x] セッション保持上限（直近10件）の管理

### Phase 4: ポップアップUI
- [x] セッション一覧画面（日時、タイトル、会議コード）
- [x] 文字起こし詳細画面（話者名、タイムスタンプ、テキスト）
- [x] データ削除機能
- [x] テキストコピー機能

### Phase 5: 字幕パネル非表示 & トグル
- [x] 字幕領域の CSS 非表示化（`position: absolute; left: -9999px` で画面外移動、DOM更新を維持）
- [x] Content Script 側にトグル用フローティングボタンを挿入
- [x] トグル状態の管理

---

### Phase 6: 設定画面（Options Page）+ セッション保持の柔軟化

#### 概要
拡張機能の設定画面を新設し、セッション保持ルールやGoogle連携などの設定をユーザーが変更できるようにする。

#### 要件
- WXT の Options Page（`entrypoints/options/`）として実装
- 設定値は `chrome.storage.local` に保存（キー: `user-settings`）
- 設定変更は Background Script が即座に反映

#### 設定項目

| カテゴリ | 設定項目 | デフォルト値 | 説明 |
|----------|----------|-------------|------|
| セッション管理 | 保持方式 | `count` | `count`（件数制限）または `days`（日数制限） |
| セッション管理 | 保持件数 | `10` | 1〜100件（保持方式が `count` の場合） |
| セッション管理 | 保持日数 | `30` | 1〜365日（保持方式が `days` の場合） |
| Google連携 | OAuth トークン | — | Phase 8 で使用。認証状態の表示 |
| テンプレート | 議事録テンプレート | デフォルトテンプレート | Phase 7 で使用 |
| テンプレート | カスタムプロンプト | 空文字列 | 将来のAI連携用。Phase 9 で使用 |

#### データモデル

```typescript
interface UserSettings {
  // セッション管理
  retention: {
    mode: "count" | "days";
    maxCount: number;   // デフォルト: 10
    maxDays: number;    // デフォルト: 30
  };
  // Google連携
  google: {
    authenticated: boolean;
    // OAuth トークンは chrome.identity で管理するため保存不要
  };
  // テンプレート
  template: {
    minutesTemplate: string;  // 議事録テンプレート
    customPrompt: string;     // AI連携用プロンプト
  };
}
```

#### 実装タスク
- [x] `utils/types.ts` に `UserSettings` 型を追加
- [x] `utils/settings.ts` に設定の読み書きヘルパーを作成（デフォルト値付き）
- [x] `entrypoints/options/index.html` + `entrypoints/options/main.ts` + `entrypoints/options/style.css` を作成
- [x] セッション管理セクションのUI実装（保持方式ラジオボタン、件数/日数スライダー）
- [x] `background.ts` の `enforceSessionLimit(10)` を設定値参照に変更
- [x] 日数制限モードの実装（`startTimestamp` と現在日時を比較して古いセッションを削除）
- [x] 設定変更時に即座にセッションクリーンアップを実行
- [x] popup ヘッダーに設定画面へのリンク（⚙アイコン）を追加

---

### Phase 7: 議事録テンプレートエンジン

#### 概要
Google Sheets エクスポート時にタブ1（議事録）のフォーマットを制御するテンプレートエンジンを実装する。

#### テンプレート変数

| 変数 | 展開内容 | 例 |
|------|---------|-----|
| `{{title}}` | ミーティングタイトル | `週次定例` |
| `{{code}}` | Google Meet 会議コード | `abc-defg-hij` |
| `{{date}}` | 開始日（YYYY年MM月DD日） | `2026年4月6日` |
| `{{startTime}}` | 開始時刻（HH:MM） | `10:00` |
| `{{endTime}}` | 終了時刻（HH:MM） | `11:00` |
| `{{duration}}` | 会議時間 | `1時間0分` |
| `{{participants}}` | 参加者一覧（カンマ区切り） | `田中, 鈴木, 佐藤` |
| `{{participantCount}}` | 参加者数 | `3` |
| `{{transcriptCount}}` | 発言ブロック数 | `42` |
| `{{transcript}}` | 整形済み文字起こし全文 | （話者・時刻・テキスト） |

#### デフォルトテンプレート

```
# {{title}}

- 日時: {{date}} {{startTime}} 〜 {{endTime}}（{{duration}}）
- 参加者（{{participantCount}}名）: {{participants}}

---

## 議事録

{{transcript}}

---

## 決定事項

-

## TODO

-
```

#### 実装タスク
- [x] `utils/template.ts` にテンプレート展開関数を作成
- [x] 変数の抽出・置換ロジック実装
- [x] 未定義変数のフォールバック処理（空文字列に置換）
- [x] `{{duration}}` 計算ヘルパー（startTimestamp, endTimestamp → "X時間Y分"）
- [x] テンプレートエンジンの単体テスト（`utils/__tests__/template.test.ts`）
- [x] Options Page のテンプレート編集UIにプレビュー機能を追加

---

### Phase 8: Google Sheets エクスポート（OAuth + Sheets API）【廃止予定 → Phase 9 で置換】

> **注意**: Phase 9 で Google Docs エクスポート + Gemini AI 要約に置き換える。
> Phase 8 で構築した OAuth 認証基盤（`google-auth.ts`、`chrome.identity`）は Phase 9 でも継続利用する。
> `google-sheets.ts` と関連テストは Phase 9a で削除する。

#### 完了済みタスク（認証基盤として Phase 9 に引き継ぎ）
- [x] `wxt.config.ts` に `identity` パーミッションと `oauth2` 設定を追加
- [x] `utils/google-auth.ts` に OAuth 認証ヘルパーを作成
- [x] Options Page に Google 連携セクションを実装（ログイン/ログアウト/状態表示）
- [x] エクスポート実行時のプログレス表示・エラーハンドリング

#### 削除予定タスク（Phase 9a で実施）
- `utils/google-sheets.ts` — Sheets API クライアント
- `utils/__tests__/google-sheets.test.ts` — Sheets API テスト
- Popup の [Sheets] エクスポートボタン

---

### Phase 9: AI 要約（3プロバイダ対応）+ Google Docs エクスポート

#### 概要
Google Sheets エクスポート（Phase 8）を廃止し、**AI 要約（OpenAI / Anthropic / Gemini の3プロバイダ対応）+ Google Docs エクスポート**に置き換える。
ユーザーが選択した AI プロバイダの API キーを使って文字起こしデータから要約を生成。
生成された要約と元の文字起こしを Google Docs ドキュメントとしてユーザーの Drive に出力する。

#### 設計方針
- **マルチプロバイダ**: OpenAI / Anthropic / Gemini の3プロバイダに対応。ユーザーが好みのプロバイダを選択可能
- **ハイブリッド認証**: Google Docs エクスポートは OAuth（`chrome.identity`）、AI 要約はユーザー自身の API キー
- **クォータ分離**: AI API のクォータ・課金は各ユーザーのアカウントに紐づく（開発者負担なし）
- **プライバシー優先**: AI 要約はユーザーの明示的操作（「AI要約」ボタン押下）でのみ実行
- **カスタムプロンプト**: ユーザーが要約プロンプトを自由にカスタマイズ可能（Phase 6 の `customPrompt` フィールドを活用）

#### 認証方式: ハイブリッド（OAuth + API キー）

| API | 認証方式 | 理由 |
|-----|---------|------|
| Google Docs API | OAuth 2.0（`chrome.identity`） | ユーザーの Drive にドキュメントを作成するためユーザー認証が必要 |
| OpenAI API | ユーザー自身の API キー | クォータ・課金を各ユーザーに帰属させるため |
| Anthropic API | ユーザー自身の API キー | クォータ・課金を各ユーザーに帰属させるため |
| Gemini API | ユーザー自身の API キー | クォータ・課金を各ユーザーに帰属させるため |

```
┌──────────────────┐    chrome.identity     ┌──────────────────┐
│  拡張機能         │ ──────────────────────→ │ Google OAuth 2.0 │
│  (popup/options) │    getAuthToken()       │                  │
│                  │ ←────────────────────── │ → access_token   │
└──────────────────┘                         └──────────────────┘
       │
       │ Authorization: Bearer {token}
       │
       └───→ Google Docs API (docs.googleapis.com)
             POST /v1/documents → 新規ドキュメント作成
             POST /v1/documents/{id}:batchUpdate → コンテンツ挿入

┌──────────────────┐    API Key (設定画面で入力)
│  拡張機能         │ ─────────────────────────────────────────→
│                  │    Authorization: Bearer {API_KEY}
└──────────────────┘
       │
       ├───→ OpenAI API (api.openai.com)
       │     POST /v1/chat/completions → 要約生成
       │
       ├───→ Anthropic API (api.anthropic.com)
       │     POST /v1/messages → 要約生成
       │
       └───→ Gemini API (generativelanguage.googleapis.com)
             POST /v1beta/models/gemini-2.0-flash:generateContent
             → 要約生成
```

#### manifest.json の変更

```json
{
  "permissions": ["identity"],
  "oauth2": {
    "client_id": "<Google Cloud Console で発行>",
    "scopes": [
      "https://www.googleapis.com/auth/documents"
    ]
  },
  "host_permissions": [
    "https://docs.googleapis.com/*",
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://generativelanguage.googleapis.com/*"
  ]
}
```

**注意**:
- `spreadsheets` スコープと `sheets.googleapis.com` のホストパーミッションは削除する
- `generativelanguage.googleapis.com` は API キー方式でもホストパーミッションが必要（Chrome 拡張機能から fetch するため）
- AI API キーは `chrome.storage.local` に保存（`UserSettings.ai.apiKey`）

#### UserSettings への追加

```typescript
interface UserSettings {
  // ... 既存フィールド ...
  ai: {
    provider: "openai" | "anthropic" | "gemini";  // 使用する AI プロバイダ
    apiKey: string;  // 選択したプロバイダの API キー
  };
}
```

#### Google Cloud Console セットアップ手順（開発者向けメモ）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成
2. **Google Docs API** を有効化
3. OAuth 同意画面を設定（外部 / テスト）
4. スコープに `documents` を追加
5. 認証情報 → OAuth 2.0 クライアント ID → Chrome 拡張機能タイプで作成
6. `client_id` を取得し、環境変数 `VITE_GOOGLE_OAUTH_CLIENT_ID` として設定

#### ユーザー向けセットアップ（AI API キー）

1. 使用したい AI プロバイダを選択（OpenAI / Anthropic / Gemini）
2. 各プロバイダのサイトで API キーを取得:
   - OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - Anthropic: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
   - Gemini: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
3. 取得した API キーを拡張機能のオプション画面に貼り付け

#### Google Docs ドキュメント構成

```
┌─────────────────────────────────────────────┐
│ [ミーティングタイトル] - 議事録              │
│                                             │
│ AI 要約                                     │
│ ─────────────────────────────               │
│ [AI が生成した要約議事録]                    │
│ - 主要な議論ポイント                        │
│ - 決定事項                                  │
│ - TODO / アクションアイテム                 │
│                                             │
│ ─────────────────────────────               │
│                                             │
│ 元の文字起こし                              │
│ ─────────────────────────────               │
│ 田中 (10:05)                                │
│ 今日の議題は...                              │
│                                             │
│ 鈴木 (10:06)                                │
│ 了解です                                    │
│ ...                                         │
└─────────────────────────────────────────────┘
```

#### カスタムプロンプト

ユーザーが Options Page で要約プロンプトをカスタマイズ可能。
Phase 6 で作成済みの `UserSettings.template.customPrompt` フィールドを活用する。

**デフォルトプロンプト**:

```
以下の会議の文字起こしを要約してください。

以下の項目を含めてください:
- 主要な議論ポイント
- 決定事項
- TODO / アクションアイテム

文字起こし:
{{transcript}}
```

- プロンプト内で `{{transcript}}` 変数を使用可能（テンプレートエンジンと同じ展開方式）
- 他のテンプレート変数（`{{title}}`, `{{participants}}` 等）も利用可能

#### フロー

**AI 要約フロー**（Popup の「AI要約」ボタン）:
```
[ユーザーが「✨ AI要約」ボタン押下]
    │
    ├─ AI API キー未設定の場合 → エラー表示
    │
    ▼ 設定済み
[1. 選択されたプロバイダの API で要約生成]
    │  OpenAI: POST api.openai.com/v1/chat/completions
    │  Anthropic: POST api.anthropic.com/v1/messages
    │  Gemini: POST generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent
    ▼
[2. 要約結果を Popup 内に表示（コピー・閉じる機能付き）]
```

**Docs エクスポートフロー**（Popup の「Docs」ボタン）:
```
[ユーザーが「Docs」ボタン押下]
    │
    ├─ Google 未認証の場合 → 確認ダイアログ → Options Page へ誘導
    │
    ▼ 認証済み
[1. Google Docs にドキュメント作成]
    │  POST docs.googleapis.com/v1/documents（Bearer token）
    ▼
[2. 議事録コンテンツを挿入（AI 要約があれば自動的に含める）]
    │  POST docs.googleapis.com/v1/documents/{id}:batchUpdate（Bearer token）
    ▼
[3. 完了！ドキュメントURLを表示（クリックで開く）]
```

#### 実装タスク

**Phase 9a: AI 連携基盤（3プロバイダ対応）**
- [x] `utils/types.ts` の `UserSettings` に `ai: { provider, apiKey }` フィールドを追加
- [x] `utils/settings.ts` のデフォルト設定に AI セクションを追加
- [x] `utils/ai-client.ts` を新規作成（OpenAI / Anthropic / Gemini 対応）
- [x] `utils/__tests__/ai-client.test.ts` の単体テスト（15テスト）
- [x] `wxt.config.ts` の `host_permissions` に AI API ドメインを追加

**Phase 9b: UI 統合**
- [x] Options Page に AI 連携カード追加（プロバイダ選択・APIキー入力・カスタムプロンプト編集・プレビュー）
- [x] Popup の詳細画面に「✨ AI要約」ボタンを追加
- [x] AI 要約結果の表示UI（コピー・閉じる機能付き）
- [x] `template.customPrompt` のデフォルト値をAI要約用プロンプトに設定

**Phase 9c: Google Sheets → Google Docs 移行**
- [x] `utils/google-docs.ts` を新規作成（`createDocument`, `writeDocumentContent`）
- [x] `utils/__tests__/google-docs.test.ts` の単体テスト（5テスト）
- [x] `wxt.config.ts` の OAuth スコープを `spreadsheets` → `documents` に変更
- [x] `wxt.config.ts` の `host_permissions` を `sheets.googleapis.com` → `docs.googleapis.com` に変更
- [x] Popup のエクスポートボタンを [Sheets] → [Docs] に変更
- [x] Docs エクスポート時に AI 要約があれば自動的にドキュメントに含める
- [x] `utils/google-sheets.ts` と `utils/__tests__/google-sheets.test.ts` を削除

#### 制約・注意事項

| 項目 | 内容 |
|------|------|
| AI API クォータ | 各ユーザー自身のプロバイダアカウントの無料枠/有料枠を使用。開発者のコスト負担なし |
| API キーの保管 | `chrome.storage.local` に保存。拡張機能のサンドボックス内なのでページスクリプトからはアクセス不可 |
| 対応プロバイダ | OpenAI（gpt-4o-mini）、Anthropic（claude-sonnet-4-20250514）、Gemini（gemini-2.0-flash） |
| OAuth 検証 | `documents` スコープは sensitive scope。本番リリース時に Google の OAuth 検証が必要。開発中はテストユーザー登録で対応 |
| ユーザーセットアップ | (1) AI プロバイダ選択 + API キー入力、(2) Google ログイン（OAuth、Docs エクスポート用） |
| スコープ変更の影響 | `spreadsheets` → `documents` への変更時、既存ユーザーは再認証が必要 |

---

## 実装フェーズの依存関係

```
Phase 6 (設定画面 + セッション保持)
   │
   ├──→ Phase 7 (テンプレートエンジン)
   │
   └──→ Phase 8 (Google OAuth 認証基盤) ──【廃止予定: Sheets 部分のみ】
               │
               └──→ Phase 9 (AI 要約 + Google Docs エクスポート)
                       │
                       ├── 9a: AI 連携基盤（3プロバイダ対応）
                       ├── 9b: UI 統合（Options + Popup）
                       └── 9c: Sheets → Docs 移行
```

**推奨実装順序**: Phase 9a → Phase 9b → Phase 9c（すべて完了）

---

## 残課題

- [x] 多言語対応（英語・日本語・スペイン語・フランス語UIでの `aria-label` 対応）
- [x] エクスポート機能（Markdown / JSON / テキスト形式でダウンロード）
- [x] 保存容量の厳密な上限定義（→ Phase 6 のセッション保持設定で対応）
- [ ] 2025年2月以降のキャプション履歴UIへの対応検証
- [x] 再接続時（ネットワーク切断→復帰）の挙動対応（ポーリング継続で再入室を自動検出）
- [x] 字幕未対応状態（ホストが字幕を無効にしている場合）のハンドリング（通知表示）
- [ ] Google Cloud Console の OAuth 設定更新（Google Docs API 有効化、`documents` スコープ追加）
- [x] `client_id` のビルド時環境変数注入の仕組み（`.env` + `wxt.config.ts`）
