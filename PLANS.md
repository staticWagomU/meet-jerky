# Meet Transcript Clipper - 実装計画

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
- [ ] WXT設定の更新（`matches` を `*://meet.google.com/*` に限定）
- [ ] 既存 `entrypoints/content.ts` にミーティング開始検出を実装（`call_end` アイコンの出現を待つ）
- [ ] `MeetingSession` / `TranscriptBlock` の型定義を作成
- [ ] Content Script ↔ Background Script 間のメッセージング基盤を構築
- [ ] Background Script に `chrome.storage.local` への保存・取得ロジックを実装
- [ ] `chrome.alarms` で5分間隔タイマー設定

### Phase 2: 字幕検出 + リアルタイム取得
- [ ] 字幕ボタンの検出とボタンクリックによる自動有効化
- [ ] MutationObserver のセットアップ（2段階構造）
  - Body監視 → 字幕領域の出現を検出
  - 字幕領域監視 → テキスト変更を検出
- [ ] 字幕テキストの重複排除ロジック
- [ ] TranscriptBlock 確定時に Background へ増分送信

### Phase 3: 永続化 + 終了時保護
- [ ] 5分タイマー発火時にバッファを `chrome.storage.local` へ永続化
- [ ] 退室ボタンへの `click` イベントリスナー追加（`MEETING_ENDED` 送信）
- [ ] タブ閉じ・ページ遷移時の best effort 保存（3層セーフティネット）
  - Content Script: `visibilitychange` イベント（`hidden` 時に最終フラッシュ）
  - Content Script: `beforeunload` イベント（フォールバック）
  - Background Script: `chrome.tabs.onRemoved` で未保存データを最終保存
- [ ] セッション保持上限（直近10件）の管理

### Phase 4: ポップアップUI
- [ ] セッション一覧画面（日時、タイトル、会議コード）
- [ ] 文字起こし詳細画面（話者名、タイムスタンプ、テキスト）
- [ ] データ削除機能
- [ ] テキストコピー機能

### Phase 5: 字幕パネル非表示 & トグル
- [ ] 字幕領域の CSS 非表示化（`visibility: hidden` / 画面外移動等、DOM更新が維持される方法を検証して採用）
- [ ] Content Script 側にトグル用フローティングボタンを挿入
- [ ] トグル状態の管理

---

## 残課題

- [ ] 多言語対応（英語UIでの `aria-label` 対応）
- [ ] 保存容量の厳密な上限定義・エクスポート機能
- [ ] 2025年2月以降のキャプション履歴UIへの対応検証
- [ ] 再接続時（ネットワーク切断→復帰）の挙動確認
- [ ] 字幕未対応状態（ホストが字幕を無効にしている場合）のハンドリング
