# Phase 6 実装に向けたコードベース調査

調査日: 2026-04-10

---

## 1. プロジェクト概要

Google Meet の字幕を自動取得・保存する Chrome 拡張機能。WXT フレームワーク + TypeScript で構築。Phase 1〜5 は完了済み。

### ファイル構成

```
meet-jerky/
├── wxt.config.ts              (9行)   ビルド設定・manifest定義
├── package.json                       bun + vitest + biome
├── tsconfig.json                      .wxt/tsconfig.json を extends
├── biome.json                         tab indentation, double quotes
│
├── entrypoints/
│   ├── background.ts          (331行) Service Worker
│   ├── content.ts             (987行) Google Meet DOM 監視
│   └── popup/
│       ├── index.html                 #app コンテナのみ
│       ├── main.ts            (466行) Vanilla TS で全UI構築
│       └── style.css          (582行) Google風デザイン
│
├── utils/
│   ├── types.ts               (27行)  データモデル定義
│   ├── messaging.ts           (77行)  メッセージプロトコル
│   ├── selectors.ts                   DOM セレクタ（多言語対応）
│   ├── helpers.ts                     フォーマット・テキスト処理
│   ├── caption-dom.ts                 字幕DOM抽出ユーティリティ
│   ├── notification.ts                トースト通知システム
│   └── __tests__/
│       ├── helpers.test.ts
│       ├── selectors.test.ts
│       ├── caption-dom.test.ts
│       └── notification.test.ts
│
└── public/icon/                       拡張機能アイコン (16〜128px + SVG)
```

**気付き**: `entrypoints/options/` ディレクトリは未作成。Phase 6 で新規作成が必要。

---

## 2. ビルド設定・パーミッション

### wxt.config.ts

```typescript
export default defineConfig({
  manifest: {
    name: "ミートジャーキー",
    description: "Google Meetの文字起こしを自動取得・保存するChrome拡張機能",
    permissions: ["storage", "alarms"],
  },
});
```

**気付き**: Phase 8 の OAuth 連携では `identity` パーミッションと `oauth2` セクションの追加が必要になる。Phase 6 時点では manifest 変更不要。

### package.json の主要ツール

| ツール | バージョン | 用途 |
|--------|-----------|------|
| wxt | ^0.20.20 | 拡張機能フレームワーク |
| vitest | ^4.1.2 | テストランナー |
| biome | 2.4.10 | リンター・フォーマッター |
| happy-dom | ^20.8.9 | DOM テスト用 |
| typescript | ^5.9.3 | 型チェック |

**気付き**: UIフレームワーク（React, Vue 等）は使用していない。popup/main.ts は Vanilla TS で DOM を直接構築している。Options Page も同様のアプローチで統一すべき。

---

## 3. データモデル（utils/types.ts）

```typescript
interface CaptionData { personName: string; text: string; }
interface TranscriptBlock { personName: string; timestamp: string; transcriptText: string; }
interface RawCaptionEntry { timestamp: string; personName: string; text: string; }
interface MeetingSession {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  startTimestamp: string;
  endTimestamp: string;
  transcript: TranscriptBlock[];
  rawTranscript: RawCaptionEntry[];
}
```

**気付き**: `UserSettings` 型はまだ存在しない。Phase 6 でここに追加する。既存の型と同じファイルに置くか、`utils/settings.ts` に分離するかの判断が必要。PLANS.md では `utils/settings.ts` に設定ヘルパーを作成する方針。型定義は `utils/types.ts` に追加が妥当。

---

## 4. ストレージ設計（background.ts）

### ストレージキー命名規則

| キー | 内容 | 管理場所 |
|------|------|---------|
| `"sessions-index"` | SessionIndexEntry[] メタデータ配列 | background.ts |
| `"session-{sessionId}"` | MeetingSession 完全データ | background.ts |
| `"onboarding-completed"` | boolean (オンボーディング完了フラグ) | popup/main.ts |

**気付き**: 設定値のストレージキーは `"user-settings"` が PLANS.md で提案されている。既存の命名規則（ハイフン区切り）と整合性がある。

### セッション制限のハードコード箇所

```typescript
// background.ts:80
const MAX_STORED_SESSIONS = 10;

// background.ts:112 — flushAndEndSession() 内で呼び出し
await enforceSessionLimit(MAX_STORED_SESSIONS);
```

`enforceSessionLimit()` 関数自体は `maxSessions: number` を引数に取る汎用的な設計（background.ts:63）。定数 `MAX_STORED_SESSIONS` を設定値に置き換えるだけで動的化できる。

**気付き**: `enforceSessionLimit()` は最古のセッションから削除する。日数制限モードを追加する場合、`startTimestamp` と現在時刻を比較する別のロジックが必要。この関数を拡張するか、新しい関数 `enforceSessionRetention()` を作るか。

### SessionIndexEntry（background.ts 内部型）

```typescript
interface SessionIndexEntry {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  startTimestamp: string;
  endTimestamp: string;
}
```

**気付き**: この型は background.ts のファイルスコープに閉じている（export されていない）。日数制限モードでは `startTimestamp` を使って古いセッションを判定するため、既存の index 構造で対応可能。

---

## 5. メッセージング（utils/messaging.ts）

### 現在のメッセージ一覧

| メッセージ型 | 方向 | payload |
|-------------|------|---------|
| `MEETING_STARTED` | Content → BG | sessionId, meetingCode, meetingTitle, startTimestamp |
| `TRANSCRIPT_UPDATE` | Content → BG | sessionId, blocks[], rawEntries[] |
| `MEETING_ENDED` | Content → BG | sessionId |
| `GET_SESSIONS` | Popup → BG | (なし) |
| `GET_TRANSCRIPT` | Popup → BG | sessionId |
| `DELETE_SESSION` | Popup → BG | sessionId |
| `UPDATE_SESSION_TITLE` | Popup → BG | sessionId, meetingTitle |
| `KEEPALIVE` | Content → BG | (なし) |

**気付き**: Phase 6 の設定機能では、設定の読み書きは `chrome.storage.local` を直接操作すれば十分で、新しいメッセージ型の追加は不要。ただし、設定変更時にセッションクリーンアップを即座に実行する場合、Background 側でストレージの `onChanged` イベントを監視するか、Options Page から直接クリーンアップメッセージを送るかの選択がある。

### 設定変更時のクリーンアップ戦略

**方法A**: `chrome.storage.onChanged` リスナーを background.ts に追加
  - メリット: メッセージ型の追加不要、どこから設定変更しても反応する
  - デメリット: background.ts への変更が少し複雑

**方法B**: `SETTINGS_UPDATED` メッセージ型を追加
  - メリット: 明示的で分かりやすい
  - デメリット: messaging.ts の変更が必要

**推奨**: 方法A（`storage.onChanged`）。設定は `chrome.storage.local` に保存するため、変更イベントが自動発火する。Background 側はイベントを拾ってクリーンアップを実行するだけ。

---

## 6. Background Script 詳細分析（background.ts: 331行）

### アーキテクチャ

```
browser.runtime.onMessage.addListener()  — メッセージハンドラ
browser.alarms.onAlarm.addListener()     — 定期永続化 (1分間隔)
browser.tabs.onRemoved.addListener()     — タブ閉じ保護
```

### インメモリ状態

| 変数 | 型 | 用途 |
|------|-----|------|
| `sessionBuffer` | `Map<string, MeetingSession>` | アクティブセッションのメモリキャッシュ |
| `tabToSession` | `Map<number, string>` | タブID → セッションID のマッピング |
| `endedSessions` | `Set<string>` | 終了済みセッション（遅延更新の拒否用） |

### 永続化タイミング

1. `MEETING_STARTED` 受信時（即座に保存 — background.ts:169）
2. `TRANSCRIPT_UPDATE` 受信時（毎回保存 — background.ts:209）
3. アラーム発火時（1分間隔 — background.ts:310-319）
4. `MEETING_ENDED` 時（`flushAndEndSession()` — background.ts:102-113）
5. タブ閉じ時（`browser.tabs.onRemoved` — background.ts:322-328）

**気付き**: 設定値の読み込みタイミングについて。`enforceSessionLimit()` は `flushAndEndSession()` 内（セッション終了時のみ）で呼ばれる。設定を反映するには:
- セッション終了時: `enforceSessionLimit()` 呼び出し前に設定値をロード
- 設定変更時: `storage.onChanged` で即座にクリーンアップ実行
- 起動時: Service Worker 起動時にも一度クリーンアップを実行すべき（日数制限の場合、長期間ブラウザを閉じていた後に古いセッションが残る可能性がある）

---

## 7. Content Script 詳細分析（content.ts: 987行）

### 主要定数

| 定数 | 値 | 用途 |
|------|-----|------|
| `POLLING_INTERVAL_MS` | 2,000ms | ミーティング参加検出ポーリング |
| `CAPTION_RETRY_INTERVAL_MS` | 1,500ms | 字幕有効化リトライ間隔 |
| `CAPTION_MAX_RETRIES` | 20 | 字幕有効化最大試行回数 |
| `IDLE_COMMIT_MS` | 2,000ms | 無入力時のブロック確定待ち |
| `FLUSH_INTERVAL_MS` | 10,000ms | Background へのフラッシュ間隔 |
| `FLUSH_THRESHOLD` | 10 | フラッシュトリガーのブロック数 |
| `REJOIN_GRACE_PERIOD_MS` | 120,000ms | 再入室猶予期間（2分） |

**気付き**: これらの定数は将来的に設定画面から変更可能にする候補。ただし Phase 6 のスコープではセッション管理のみ。過度な設定項目追加は避けるべき。

### UI要素の注入

Content Script は2つのフローティング要素を Google Meet ページに注入:

1. **字幕トグルボタン** — `position: fixed; bottom: 80px; right: 24px; z-index: 99999`
2. **録音インジケータパネル** — `position: fixed; bottom: 120px; right: 24px; z-index: 99999`

**気付き**: Phase 6 では Content Script への変更は不要。設定画面は Options Page として独立ページで実装する。

---

## 8. Popup UI 分析（popup/main.ts: 466行）

### アーキテクチャ

- **Vanilla TS**: フレームワーク不使用。DOM を直接構築
- **SPA風ナビゲーション**: `renderSessionList()` / `renderTranscriptDetail()` / `renderOnboarding()` で画面切り替え
- **app要素**: `document.querySelector<HTMLDivElement>("#app")` を起点に `innerHTML` で全体を書き換え

### 画面構成

| 画面 | 関数 | 説明 |
|------|------|------|
| オンボーディング | `renderOnboarding()` | 初回起動時の説明画面 |
| ローディング | `renderLoading()` | データ取得中 |
| セッション一覧 | `renderSessionList()` | 保存済みセッション表示 |
| 文字起こし詳細 | `renderTranscriptDetail()` | 選択セッションの全文表示 |

### ヘッダー部分

popup/main.ts のセッション一覧画面のヘッダーにロゴ "MJ" とタイトル "ミートジャーキー" が表示されている。

**気付き**: PLANS.md に「popup ヘッダーに設定画面へのリンク（⚙アイコン）を追加」とある。ヘッダーの HTML 構造を確認して、⚙ リンクの追加箇所を特定する必要がある。`renderSessionList()` 関数内のヘッダー要素に追加する形になる。

### オンボーディングのストレージ

```typescript
const ONBOARDING_KEY = "onboarding-completed";
// popup/main.ts:456
const result = await browser.storage.local.get(ONBOARDING_KEY);
```

`browser.storage.local` を使用（`localStorage` ではない）。設定値も同じ `browser.storage.local` に保存するため、アクセスパターンは統一されている。

---

## 9. 既存テストの状況

### テストファイル一覧

| ファイル | 対象 |
|---------|------|
| `utils/__tests__/helpers.test.ts` | フォーマット・テキスト処理 |
| `utils/__tests__/selectors.test.ts` | DOM セレクタ |
| `utils/__tests__/caption-dom.test.ts` | 字幕DOM抽出 |
| `utils/__tests__/notification.test.ts` | トースト通知 |

### テスト環境

- vitest + happy-dom
- `vitest run` で実行

**気付き**: `utils/settings.ts` を新規作成する場合、`utils/__tests__/settings.test.ts` も作成してデフォルト値やマージロジックのテストを書くべき。TDD アプローチで進めるのが理想的。

---

## 10. Phase 6 実装に向けた影響分析

### 新規作成が必要なファイル

| ファイル | 内容 |
|---------|------|
| `utils/settings.ts` | 設定の読み書きヘルパー（デフォルト値付き） |
| `utils/__tests__/settings.test.ts` | 設定ヘルパーのテスト |
| `entrypoints/options/index.html` | Options Page の HTML テンプレート |
| `entrypoints/options/main.ts` | Options Page のロジック |
| `entrypoints/options/style.css` | Options Page のスタイル |

### 変更が必要な既存ファイル

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `utils/types.ts` | `UserSettings` 型の追加 | 低（追加のみ） |
| `entrypoints/background.ts` | セッション制限の動的化 + `storage.onChanged` リスナー追加 | 中 |
| `entrypoints/popup/main.ts` | ヘッダーに⚙リンク追加 | 低（HTML文字列の一部変更） |
| `entrypoints/popup/style.css` | ⚙リンクのスタイル追加 | 低 |

### 変更不要なファイル

| ファイル | 理由 |
|---------|------|
| `wxt.config.ts` | WXT が `entrypoints/options/` を自動検出するため manifest 手動変更不要 |
| `utils/messaging.ts` | 設定は `storage.local` 直接操作で十分。メッセージ型追加不要 |
| `entrypoints/content.ts` | Phase 6 では Content Script への変更は不要 |
| `utils/selectors.ts` | DOM セレクタに変更なし |
| `utils/caption-dom.ts` | 字幕処理に変更なし |

---

## 11. WXT の Options Page 規約

WXT は `entrypoints/options/index.html` を配置すると自動的に Options Page として認識する。manifest.json に `options_page` や `options_ui` が自動追加される。

WXT での Options Page の一般的な構成:

```
entrypoints/options/
├── index.html    ← 必須。WXT がエントリポイントとして認識
├── main.ts       ← メインロジック
└── style.css     ← スタイル
```

**気付き**: popup と同じ Vanilla TS パターンで実装すればコードの一貫性が保てる。popup/index.html の構造をベースにすればよい。

---

## 12. 設定値のデフォルト値戦略

PLANS.md の `UserSettings` 型:

```typescript
interface UserSettings {
  retention: {
    mode: "count" | "days";
    maxCount: number;   // デフォルト: 10
    maxDays: number;    // デフォルト: 30
  };
  google: { authenticated: boolean; };
  template: { minutesTemplate: string; customPrompt: string; };
}
```

**気付き**: Phase 6 では `retention` のみ実装すればよい。`google` と `template` は Phase 7〜9 のスコープ。ただし型定義は先に作っておくと後の Phase で差分が小さくなる。

デフォルト値のマージ戦略として、ストレージから読んだ値と `DEFAULT_SETTINGS` を deep merge する関数を `utils/settings.ts` に用意する。これにより、将来の Phase で新しい設定項目を追加しても既存ユーザーのデータが壊れない。

---

## 13. 実装順序の推奨

PLANS.md のタスクリストを依存関係に基づいて整理:

1. **`utils/types.ts`** — `UserSettings` 型追加
2. **`utils/settings.ts`** + テスト — 設定ヘルパー（デフォルト値、読み書き、マージ）
3. **`entrypoints/background.ts`** — `enforceSessionLimit` の動的化 + `storage.onChanged` + 日数制限ロジック
4. **`entrypoints/options/`** — Options Page 新規作成（HTML + TS + CSS）
5. **`entrypoints/popup/main.ts`** — ヘッダーに⚙リンク追加

ステップ 1〜2 は他に依存しないため先行して TDD で実装可能。ステップ 3 は 2 に依存。ステップ 4〜5 は 2 に依存するが互いに独立。
