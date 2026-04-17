# Meet Jerky - 開発計画

会議音声リアルタイム文字起こしデスクトップアプリ

> **リポジトリ構成**: meet-jerky リポジトリ内の `desktop/` サブディレクトリで開発する。既存のChrome拡張機能（ルートディレクトリ）とは独立。

## 技術スタック

| レイヤー | 技術 | 備考 |
|---------|------|------|
| フレームワーク | Tauri 2 | システムトレイ組み込み済み |
| バックエンド | Rust | Nix (flake.nix) 経由で管理 |
| フロントエンド | React + TanStack (Router, Query) | Vite + TypeScript |
| 音声キャプチャ(mac) | `screencapturekit` v1.5.4 + AVAudioEngine | ✅ 検証済み：安定 |
| 音声キャプチャ(win) | WASAPI Loopback + Capture (windows-rs) | Phase 7 で対応 |
| 文字起こし(ローカル) | whisper-rs v0.16.0 (CPU優先) | ⚠️ Metal不安定、CPU起動で開始 |
| 文字起こし(ローカル代替) | candle-transformers (Metal対応) | whisper-rs の速度不足時に切替 |
| 文字起こし(クラウド) | OpenAI Whisper API | Phase 6 で対応 |
| 配布 | .dmg (mac) / .msi (win) via Google Drive | |

---

## リスク検証結果（2026-04-17 実施）

### ✅ ScreenCaptureKit (`screencapturekit` クレート)

- **判定: USE** — そのまま採用OK
- v1.5.4 (2026-03-09更新)、DL 44万超、活発にメンテ
- 音声のみキャプチャ対応済み（`with_captures_audio(true)`）
- Apple Silicon固有の致命的バグなし（過去のクラッシュ問題は修正済み）
- Apple APIの制約上、画面指定は必要（ビデオフレームは無視すればOK）

### ⚠️ whisper-rs

- **判定: USE WITH CAUTION** — CPU推論で開始、速度不足時に代替検討
- v0.16.0 (2026-03-12更新)、DL 28万
- **Metal加速が不安定**：M1 Maxでゴミ出力の報告あり。環境変数の手動設定が必要
- **Core ML**：初回ロードのキャッシュ問題が未解決
- **CPU推論は安定**。smallモデルならリアルタイム可能
- **リポジトリがGitHubからCodebergに移行済み**（メンテナーがGenAI反対の立場）
- **代替候補**: `candle-transformers` v0.10.2（Hugging Face製、147万DL、Metal対応、活発メンテ）

**戦略**: whisper-rs (CPU, smallモデル) → 速度不足なら candle-transformers (Metal) に切替
TranscriptionEngine trait で抽象化するため、エンジン差し替えは容易。

### ✅ Tauri 2 システムトレイ

- **判定: 実現可能** — 定番ワークアラウンドあり
- `tray_icon` 機能がTauri 2本体に組み込み済み（プラグイン不要）
- ネイティブポップオーバーAPIはないが、ボーダーレスウィンドウで代替
- `tray_rect()` でアイコン位置取得 → ウィンドウ位置を計算して表示
- `Focused(false)` イベントでフォーカス外れ時に自動非表示

### 環境

- macOS 26.3 (arm64) ✅
- Node.js v25.8.2 ✅
- Xcode インストール済み ✅
- Nix (Determinate Nix 3.11.2) ✅
- direnv v2.37.1 ✅
- **Rust** → Nix flake.nix 経由でプロジェクトローカルに提供

---

## Phase 0: プロジェクト初期設定

**ゴール**: Tauri 2 + React + TanStack のボイラープレートが動く状態

- [x] Nix 開発環境構築
  - [x] `flake.nix` 作成（リポジトリルートに配置。Chrome拡張とデスクトップアプリ両方の開発環境をカバー。Rust toolchain, Node.js, Tauri依存ライブラリ）
  - [x] `.envrc` 作成（`use flake`）
  - [x] `direnv allow` で環境有効化
  - [x] `rustc --version` / `cargo --version` 動作確認
- [x] Tauri 2 プロジェクト scaffold (`desktop/` ディレクトリに作成)
- [x] React + TypeScript + Vite セットアップ
- [x] TanStack Router 導入（Settings / Transcript の2画面）
- [x] TanStack Query 導入
- [x] システムトレイ基本実装（`TrayIconBuilder` + `tray_icon` 機能）
- [x] ボーダーレスウィンドウ：トレイクリックでポップオーバー表示
  - `decorations: false`, `always_on_top: true`
  - `tray_rect()` でアイコン位置取得 → ウィンドウ位置計算
  - `Focused(false)` で自動非表示
- [x] Rust側の基本ディレクトリ構造作成

**成果物**: トレイ常駐してクリックでポップオーバーウィンドウが出るアプリ

---

## Phase 1: マイク入力キャプチャ（macOS）

**ゴール**: マイク音声をRust側でPCMバッファとして取得できる

- [x] AVAudioEngine をRustから呼ぶ（objc2 クレート経由）
- [x] マイクアクセス権限リクエスト処理
- [x] 音声フォーマット変換（→ 16kHz / mono / f32）
- [x] リングバッファ実装（音声データの一時保持）
- [x] フロントエンドに音声レベルメーターを表示（動作確認用）

**成果物**: マイクに話すと音声レベルが表示されるアプリ

### なぜマイクから始めるか
ScreenCaptureKitよりAVAudioEngineのほうがシンプル。
まずマイク→文字起こしの縦串を通してから、システム音声を追加する。

---

## Phase 2: ローカル文字起こし（whisper-rs）

**ゴール**: マイク音声をリアルタイムに文字起こしできる

- [x] whisper-rs クレート導入（CPU推論、Metal/CoreMLは無効で開始）
- [x] Whisperモデル管理（ダウンロード・パス管理）
- [x] 初回起動時のモデル自動ダウンロード（**small で開始**、後から medium に切替可能に）
  - [x] ダウンロードプログレスバーUI
- [x] VAD（Voice Activity Detection）による発話区間検出
- [x] 発話チャンクをwhisper-rsに投入→テキスト取得
- [x] TranscriptionEngine trait 定義（ローカル/クラウド抽象化）
- [x] Tauri Events でフロントエンドにリアルタイム送信
- [x] フロントエンドでテキストをリアルタイム表示
- [x] **速度検証**: small (CPU) でリアルタイム性を確認 (インフラ構築済み、実機テスト未実施)
  - RTF > 1.0 の場合 → candle-transformers (Metal) への切替を Phase 2.5 として実施

**成果物**: マイクに話すとリアルタイムで文字起こしが表示されるアプリ

### Phase 2.5（条件付き）: candle-transformers への切替

**トリガー**: Phase 2 の速度検証で whisper-rs (CPU) がリアルタイムに間に合わない場合

- [ ] candle-transformers + candle-nn 導入
- [ ] Metal バックエンド有効化
- [ ] Whisper モデルの GGUF/safetensors ロード
- [ ] TranscriptionEngine trait の candle 実装
- [ ] 速度再検証

---

## Phase 3: システム音声キャプチャ（macOS）

**ゴール**: システム音声（会議相手の声）もキャプチャして文字起こしできる

- [x] `screencapturekit` クレート導入（v1.5.4）
- [x] 画面録音権限リクエスト処理・ガイドダイアログ
- [x] 音声のみキャプチャ設定（`with_captures_audio(true)`、ビデオフレームは無視）
- [x] フォーマット変換（→ 16kHz / mono / f32）
- [x] AudioCapture trait 定義（macOS / Windows 抽象化）
- [x] 2ストリーム（マイク + システム音声）の並行文字起こし
- [x] 話者ラベル付与：「自分」（マイク）/「相手」（システム音声）
- [x] フロントエンドで話者別に色分け表示

**成果物**: 会議中に相手の声と自分の声が分離されて文字起こしされるアプリ

---

## Phase 4: UI 仕上げ

**ゴール**: バックオフィスメンバーが迷わず使えるUI

- [ ] 録音開始/停止ボタン（トレイメニュー + ウィンドウ内）
- [ ] 設定画面
  - [ ] 文字起こしエンジン選択（ローカル / クラウド）
  - [ ] Whisperモデル選択（small / medium / large-v3）
  - [ ] マイクデバイス選択
  - [ ] クラウドAPIキー入力・保存（暗号化）
  - [ ] 出力先ディレクトリ設定
  - [ ] 言語設定（日本語 / 英語 / 自動検出）
- [ ] リアルタイム文字起こし画面
  - [ ] 話者別色分け
  - [ ] 自動スクロール
  - [ ] テキスト選択・コピー
- [ ] 権限未設定時のガイダンスUI（macOS画面録音権限）
- [ ] モデルダウンロード状態表示

**成果物**: 完成度の高いmacOS版アプリ

---

## Phase 5: Markdown出力

**ゴール**: 会議終了後にタイムスタンプ付きMarkdownファイルが保存される

- [ ] セッション管理（録音開始〜停止を1セッションとして管理）
- [ ] Markdownフォーマッタ実装
  ```markdown
  # 会議メモ - 2026-04-17 14:30

  **[14:30:05] 相手:** それでは始めましょう。
  **[14:30:12] 自分:** よろしくお願いします。
  ```
- [ ] リアルタイム書き出し（アプリ落ちても途中まで残る）
- [ ] セッション一覧画面（過去の文字起こし履歴）
- [ ] ファイルを開く / フォルダを開くボタン

**成果物**: 会議後にMarkdownファイルが自動生成されるアプリ

---

## Phase 6: クラウドAPI対応

**ゴール**: ローカル推論が重い環境でもクラウドAPIで文字起こしできる

- [ ] OpenAI Whisper API クライアント実装
- [ ] APIキーの安全な保存（macOS: Keychain / Windows: Credential Manager）
- [ ] エンジン切り替えUI
- [ ] ネットワークエラー時のフォールバック/リトライ
- [ ] APIコスト概算の表示（オプション）

**成果物**: ローカル/クラウドを選択して文字起こしできるアプリ

---

## Phase 7: Windows対応

**ゴール**: Windowsでも同等の機能が動作する

- [ ] WASAPI Loopback キャプチャ実装（windows-rs）
- [ ] WASAPI マイクキャプチャ実装
- [ ] AudioCapture trait の Windows実装
- [ ] Windows環境での whisper-rs ビルド確認（CUDA / CPU）
- [ ] .msi インストーラー生成（Tauri bundler）
- [ ] Windows固有のUI調整（ダークモード対応等）
- [ ] Windows実機テスト

**成果物**: Windows版 .msi パッケージ

---

## Phase 8: 配布・運用

**ゴール**: バックオフィスメンバーに安全に配布できる

- [ ] macOS: コード署名 + 公証（Notarization）
  - ※ Apple Developer Program (年$99) が必要
  - 署名なしの場合: Gatekeeper回避手順のドキュメント作成
- [ ] Windows: コード署名（オプション、SmartScreenの警告回避）
- [ ] Tauri Updater 設定（Google Drive or 自前サーバー）
- [ ] 社内向けインストールガイド作成
- [ ] トラブルシューティングガイド作成

**成果物**: 配布可能なパッケージ + ドキュメント一式

---

## 技術的リスクと対策

| リスク | 影響度 | 検証状態 | 対策 |
|--------|--------|----------|------|
| ScreenCaptureKit のRustバインディング | 高 | ✅ 検証済み：安定 | `screencapturekit` v1.5.4 をそのまま採用 |
| whisper-rs のGPU加速（Metal/CoreML） | 高 | ⚠️ 問題あり | CPU (small) で開始。速度不足なら candle-transformers (Metal) に切替 |
| Tauri 2 のシステムトレイ | 中 | ✅ 検証済み：実現可能 | ボーダーレスウィンドウ + tray_rect() で対応 |
| Rust未経験による学習コスト | 中 | — | Phase 1を意図的にシンプルに。段階的にRust力を上げる |
| Nix環境でのTauriビルド | 低 | — | macOS frameworkのリンクに注意。flake.nixで`Security`等のframeworkを明示 |
| macOSコード署名コスト($99/年) | 低 | — | 署名なし配布 + Gatekeeper回避手順で最初は対応 |
| whisper-rs リポジトリのCodeberg移行 | 低 | ⚠️ 要注意 | 長期的には candle-transformers への移行を視野に |

---

## 開発の進め方

1. 各PhaseでTDDを意識：先に期待する動作を定義 → 実装 → リファクタ
2. **Phase 0-2を最速で通す**（マイク→文字起こし表示の縦串）
3. Phase 2完了時に**速度検証**：RTF > 1.0 なら Phase 2.5 で candle-transformers に切替
4. Phase 3で本丸のシステム音声キャプチャに取り組む
5. Phase 4-5でUI/出力を磨く
6. Phase 6-8で横展開（クラウド・Windows・配布）
