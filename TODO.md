# Phase 6: 設定画面（Options Page）+ セッション保持の柔軟化 — TODO

## 実装方針

- TDD（Red → Green → Refactor）で進める
- 設定変更時のクリーンアップは `chrome.storage.onChanged` リスナー方式（RESEARCH.md §5 方法A）
- Vanilla TS で実装（既存 popup と統一）
- デフォルト値は deep merge 戦略で将来の設定項目追加に対応

---

## Step 1: データモデル — `UserSettings` 型追加

依存: なし

- [ ] `utils/types.ts` に `UserSettings` 型を追加
  ```typescript
  interface UserSettings {
    retention: {
      mode: "count" | "days";
      maxCount: number;   // デフォルト: 10
      maxDays: number;    // デフォルト: 30
    };
    google: { authenticated: boolean };
    template: { minutesTemplate: string; customPrompt: string };
  }
  ```
  - Phase 6 で実装するのは `retention` のみ。`google` / `template` は型定義だけ先行して用意

---

## Step 2: 設定ヘルパー — `utils/settings.ts` + テスト

依存: Step 1

- [ ] `utils/__tests__/settings.test.ts` を作成（RED）
  - `DEFAULT_SETTINGS` が正しいデフォルト値を持つこと
  - `mergeSettings()` が部分的な保存値とデフォルト値を deep merge すること
  - `mergeSettings()` で未知のキーが無視されること
  - `loadSettings()` がストレージ未設定時にデフォルト値を返すこと
  - `saveSettings()` が `chrome.storage.local` に正しく保存すること
- [ ] `utils/settings.ts` を作成（GREEN）
  - `DEFAULT_SETTINGS` 定数（全設定項目のデフォルト値）
  - `SETTINGS_STORAGE_KEY = "user-settings"` 定数
  - `mergeSettings(partial, defaults)` — deep merge 関数
  - `loadSettings()` — ストレージから読み込み + デフォルト値マージ
  - `saveSettings(settings)` — ストレージへ保存
- [ ] リファクタリング（REFACTOR）

---

## Step 3: Background Script — セッション制限の動的化

依存: Step 2

- [ ] `entrypoints/background.ts` の `MAX_STORED_SESSIONS` 定数（L80）を設定値参照に変更
  - `flushAndEndSession()` 内で `loadSettings()` を呼び出し、`retention` 設定を取得
  - `retention.mode === "count"` の場合: `enforceSessionLimit(settings.retention.maxCount)`
  - `retention.mode === "days"` の場合: 日数制限ロジックを実行
- [ ] 日数制限モードの実装
  - `enforceRetentionByDays(maxDays: number)` 関数を追加
  - `sessions-index` から `startTimestamp` を読み、現在日時との差が `maxDays` を超えるセッションを削除
- [ ] `chrome.storage.onChanged` リスナーを追加
  - `user-settings` キーの変更を監視
  - 設定変更時に即座にクリーンアップを実行（新しい制限値に基づく）
- [ ] Service Worker 起動時にもクリーンアップを1回実行
  - 長期間ブラウザを閉じていた後に古いセッションが残る問題への対処

---

## Step 4: Options Page — 新規作成

依存: Step 2

### 4a: HTML テンプレート
- [ ] `entrypoints/options/index.html` を作成
  - `popup/index.html` をベースに `#app` コンテナを配置

### 4b: メインロジック
- [ ] `entrypoints/options/main.ts` を作成
  - 起動時に `loadSettings()` で現在の設定値をロード
  - セッション管理セクション:
    - 保持方式ラジオボタン（`count` / `days`）
    - 件数入力（1〜100、`mode === "count"` 時のみ有効）
    - 日数入力（1〜365、`mode === "days"` 時のみ有効）
  - 保存ボタン押下時に `saveSettings()` で保存
  - 保存成功時にトースト通知を表示
  - Google 連携 / テンプレートセクションは Phase 7〜9 のプレースホルダー（disabled 表示）

### 4c: スタイル
- [ ] `entrypoints/options/style.css` を作成
  - `popup/style.css` の Google 風デザインを踏襲
  - セクション分割・フォーム要素のスタイリング

---

## Step 5: Popup ヘッダーに設定リンク追加

依存: Step 4（Options Page が存在すること）

- [ ] `entrypoints/popup/main.ts` の `renderSessionList()` ヘッダー部分に ⚙ アイコンリンクを追加
  - クリック時に `chrome.runtime.openOptionsPage()` を呼び出し
- [ ] `entrypoints/popup/style.css` に ⚙ リンクのスタイルを追加

---

## 検証チェックリスト

- [ ] `bun run test` — 全テスト通過（既存 + 新規 settings テスト）
- [ ] `bun run lint` — Biome リント通過
- [ ] `bun run build` — ビルド成功、Options Page が manifest に自動追加されていること
- [ ] 手動テスト: Options Page で件数を変更 → 保存 → セッション数が制限に収まること
- [ ] 手動テスト: Options Page で日数モードに切り替え → 古いセッションが削除されること
- [ ] 手動テスト: Popup の ⚙ アイコンから Options Page が開くこと
