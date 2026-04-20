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

- [x] 録音開始/停止ボタン（トレイメニュー + ウィンドウ内）
- [x] 設定画面
  - [x] 文字起こしエンジン選択（ローカル / クラウド）
  - [x] Whisperモデル選択（small / medium / large-v3）
  - [x] マイクデバイス選択
  - [ ] クラウドAPIキー入力・保存（暗号化） ← Phase 6で実装
  - [x] 出力先ディレクトリ設定
  - [x] 言語設定（日本語 / 英語 / 自動検出）
- [x] リアルタイム文字起こし画面
  - [x] 話者別色分け
  - [x] 自動スクロール
  - [x] テキスト選択・コピー
- [x] 権限未設定時のガイダンスUI（macOS画面録音権限）
- [ ] モデルダウンロード状態表示 ← 進捗イベントは発火済み、UI側の購読が残タスク

**成果物**: 完成度の高いmacOS版アプリ

---

## Phase 5: Markdown出力

**ゴール**: 会議終了後にタイムスタンプ付きMarkdownファイルが保存される

- [x] セッション管理（録音開始〜停止を1セッションとして管理）※データ型＋ライフサイクル完成、UI配線は残
- [x] Markdownフォーマッタ実装
  ```markdown
  # 会議メモ - 2026-04-17 14:30

  **[14:30:05] 相手:** それでは始めましょう。
  **[14:30:12] 自分:** よろしくお願いします。
  ```
- [x] Markdown保存（ディレクトリへのファイル書き出し）
- [x] TranscriptSegment → SessionSegment 変換ブリッジ
- [x] リアルタイム書き出し（アプリ落ちても途中まで残る）
- [x] Tauri コマンド配線（start_session / append / finalize）
- [x] セッション一覧画面（過去の文字起こし履歴）
- [x] ファイルを開く / フォルダを開くボタン

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

---

## 進捗ログ・気付き

### 2026-04-20: Loop B - セッション一覧UI (Phase 5)
- commits: `5e4e2f3`
- 採用プラグイン: `@tauri-apps/plugin-opener` (既にプロジェクト導入済み)
  - `openPath(path)`: OSデフォルトアプリで .md ファイルを開く
  - `revealItemInDir(path)`: ファインダ/エクスプローラでファイルをハイライト表示
  - capabilities/default.json に `opener:allow-open-path` を追加（`opener:default` だけでは reveal 用パスが通らない）
- 実装:
  - `desktop/src/hooks/useSessionList.ts`: TanStack Query で `invoke('list_session_summaries_cmd')` をラップ
  - `desktop/src/routes/SessionList.tsx`: 履歴一覧 + 行ごとに「ファイルを開く」「フォルダを開く」ボタン
  - `desktop/src/App.tsx` のナビゲーションに「履歴」リンクを追加し `/sessions` へ遷移
  - `desktop/src/App.css` に `.session-list-*` クラスを追加
- 気付き:
  1. **フロントエンドのテストインフラが存在しない**（vitest/RTL なし）ため、原義のTDD Red/Green は実施不能。代替として `bun run build` (tsc + vite) と `cargo check` を緑にして擬似検証。今後フロント側で自動テストが欲しくなるなら vitest 導入は別ループで提案
  2. **sub-agent がストール**した（600s タイムアウト、CSS 追加直前）。原因不明だが、途中成果物は作業ツリーに残っていたため、リーダー側で引き継いでCSS追加→build検証→コミットで完遂。並列実行時はこの「中途半端な作業ツリー」を拾える前提で動く
  3. **`plugin-opener` は Tauri v2 の公式プラグイン**。`invoke('plugin:opener|openPath')` を直に呼ぶ代わりに `@tauri-apps/plugin-opener` の型付き API を使えた。プラグイン選定は Cargo.toml / package.json 両方に既に入っていたため追加作業不要
- 残タスク:
  - セッション一覧を開くたびに refetch するか TanStack Query のキャッシュ戦略を決める（現状は stale-while-revalidate のデフォルト）
  - 「フォルダを開く」で `reveal` 失敗時のユーザー向けトースト（現状は console.error）
  - 一覧から行削除（ファイル削除）機能 — 将来タスク

### 2026-04-20: Loop A - インクリメンタル書き出し (Phase 5)
- commits: `25e66df`, `248c629`, `ffea865`, `258c272`, `b87874d`, `2e742ac`, `ed821d1`
- 設計判断: **全文上書き戦略**を採用。append / finalize のたびに対応 `.md` ファイルを
  `write` で完全に書き直す。Markdown は小さく、append のレートも人間の発話速度
  （毎秒数回が上限）なので最適化は不要。ファイル追記（open+seek+write）より
  クラッシュ耐性が高く（partial write の窓が短い）、フォーマッタが純粋関数のままで済む。
  SessionManager に `Option<ActiveOutput>` を持たせ、`start_with_output` で構成された
  セッションのみ書き出しを発火させる設計にしたため、既存の in-memory 専用テスト
  （Loop 4 由来の4テスト）は触らずに済んだ。
- 気付き:
  1. **書き出しパスの一元化**: `session_store::path_for_session` と
     `write_session_markdown_to` を factor out することで、`SessionManager` と
     `save_session_markdown` の両方が同じパス計算を共有。path 不一致による
     "finalize 時にファイルが 2 つできる" バグの余地を排除できた。
  2. **Tauri 境界の signature 変更は `_inner` パターンで安全に**: `start_session_inner`
     に `output_dir: &Path` と `offset: FixedOffset` を足したが、純粋関数のため
     テストだけ更新すれば Tauri コマンド側は state から resolve するだけで済む。
     `_inner` パターンの拡張容易性を改めて確認。
  3. **ディスク書き込みエラーは in-memory 優先で握り潰す**: append のたびに
     `write_session_markdown_to` が `io::Error` を返す可能性があるが、これで
     `SessionManager::append` が失敗扱いになると in-memory session との状態が
     乖離する。`eprintln!` でログしつつ `Ok(())` を返す方針にした。将来 tracing
     導入時に差し替える。
- 残タスク / 将来検討:
  - **書き込みエラー処理**: 現状 `eprintln!`。tracing 導入後に構造化ログへ移行。
  - **fsync**: クラッシュ耐性を強化するなら `File::sync_all` を検討。Markdown
    書き出しは人間のタイピング速度なのでコスト許容範囲だが、macOS の APFS は
    デフォルトで十分安全なので優先度低。
  - **並行書き込み**: 現在はロック下で同期書き出し。毎回 1〜数 KB なので
    ブロッキングは無視できるが、将来モデル推論とファイル I/O を分離する場合は
    channel ベースのライタータスクを検討。
  - **Tauri コマンド側の直接テスト**: `start_session` Tauri コマンド（state 経由）の
    自動テストは引き続き未実装。`_inner` が十分広いカバレッジを持つので当面不要。

### 2026-04-20: Phase 5 セッション試合の総括（5ループ完走）

#### サマリー
- **合計 21 コミット、19 テスト追加（42→61）、全緑維持**
- 新規モジュール 6 つ: `markdown.rs`, `datetime_fmt.rs`, `session.rs`, `session_store.rs`, `transcript_bridge.rs`, `session_manager.rs`, `session_commands.rs`
- 追加 crate: `chrono`, `thiserror`, `tempfile`(dev-only)
- Phase 5 バックエンド層は実質完成、残るはライブパイプラインとの配線 + フロント連携

#### 並列TDDの学び
1. **独立ファイル作成は並列安全**。共有ファイル（`lib.rs`）へのmod追記もアルファベット順なら衝突しにくい
2. **並列でテストが一瞬壊れる状態**が発生しうる（Loop 2B実行中にSession未実装）。依存関係がある場合は直列化を検討
3. **サブエージェントが依頼側の手計算エラーを検証で修正した事例**（Loop 2B、epoch秒→JST時刻）。"期待値を独立計算する"TDD規律が実働
4. **自己批評も出てくる**（Loop 4B: Cycle 1実装が過剰で真のRedを作り損ねた）。サブエージェントの誠実な報告を評価
5. **Tauri境界のテスト難は `_inner`パターンで突破**可能（Loop 5）

#### 2026-04-20: Phase 4実態同期 + Phase 5 TDD開始
- Phase 4のチェックボックスを実態に同期（11/12完了、クラウドAPIキーはPhase 6へ、モデルDL進捗UIは残タスク）
- 直近コミット `12601a0`, `a0d579b` でUI仕上げがほぼ完了していたがplan.mdが未更新だった → 今後は実装完了時にチェックボックスを必ず更新するルールを追加
- Phase 5 Markdownフォーマッタから原義TDD（Red→Green→Refactor）で着手

### Loop 5: Tauriコマンド配線（単独トラック）
- commits: `ba89a3b`, `8ae0942`, `01437ce`, `023cf00`, `cf37a28`（6テスト追加、`session_commands.rs` 新設）
- **設計パターン**: `_inner`（純粋・テスト可）＋ `#[tauri::command]`（薄いアダプタ）に分離。Tauri境界のユニットテスト難を回避
- 公開コマンド: `start_session` / `finalize_and_save_session` / `list_session_summaries_cmd`。`append` は内部呼び出し専用（フロントから直接叩く必要なし）
- `SessionSummary` は `#[derive(Serialize)]` + `camelCase` でフロント側に `{ path, startedAtSecs, title }` として渡る
- **残タスク**: `transcription.rs` の live loop から `SessionManager::append` を呼ぶ配線。Phase 3の音声パイプライン安定性を尊重し、次セッション以降で専用設計
- **設計注意**: timezoneがJSTハードコード（`FixedOffset::east_opt(9*3600)`）。将来OSロケール依存に

### Loop 4: SessionManager + セッションサマリー（並列2トラック）
- Track A commits: `8f654bc`, `9faa7ad`, `cf05d73`, `7a929bd`, `58d09e8`（`session_manager.rs`、thiserror追加、4テスト+1refactor）
- Track B commits: `6db21a0`, `6cf634a`, `b5a68d8`（`session_store.rs` に `list_session_summaries` 追加、3テスト）
- **気付き**: SessionManagerのMutexロックパターン6箇所をヘルパーに集約する自発的Refactor。poison時のメッセージも `expect("session manager mutex poisoned")` に改善
- **自己批評（Track B）**: Cycle 1で過剰実装（sort+defensive parse）したためCycle 2/3がそれぞれ真のRedにならなかった。strict TDDの規律として要反省。テスト自体は回帰ネットとして有効だが、次回はCycle 1を最小限に絞る
- `SessionManagerError` は `serde::Serialize` 未実装 → Tauriコマンド境界で必要
- 累積55テスト全緑

### Loop 3: 永続化 + TranscriptSegment変換（並列2トラック）
- Track A commits: `c6efc36`, `c66e8b5`, `08ba564`（`session_store.rs`、tempfile追加、3テスト）
- Track B commits: `b685332`, `f0c8ed4`, `9ab39b5`（`transcript_bridge.rs`、3テスト）
- **重要発見**: `TranscriptionSegment.start_ms` は**ストリーム相対**時刻でunix wall-clockではない → wiring層で `stream_started_at_secs` を別途渡す必要あり
- **設計判断**: 時刻逆転時はoffsetを0に飽和させる（エラーにせず、データを失わない）。"バグ"ではなく"データ"として扱う
- `session_store` は段階的ではなく **終了時一括書き出し** のみ実装。インクリメンタル書き出しは別ループへ
- 累積48テスト全緑

### Loop 2: セッション型 + datetime整形（並列2トラック）
- Track A commits: `9acf313`, `6d19642`, `e65198b`（`session.rs`、3テスト）
- Track B commits: `98c8943`, `5009018`, `56a429a`（`datetime_fmt.rs` + chrono追加、3テスト）
- **気付き**: 並列TDDでは独立ファイルは安全、共有ファイル（`lib.rs`）は単行追記ならアルファベット順でマージ可能だった（衝突なし）
- **気付き**: サブエージェントが依頼側の手計算エラー（epoch秒の時刻）を検証時に修正。TDDのRedフェーズで「期待値を独立計算する」規律が機能した
- **気付き**: Track B実行中は `session.rs` 未実装でフルテスト不能の一瞬があった → Track BはTrack A完了後に流すほうが安全だったかも。次の並列では依存関係を見る
- ID生成: uuid未導入のため `AtomicU64 + started_at` の暫定ID。永続化層で uuid 切替を検討
- 累積42テスト全緑

### Loop 1: Markdownフォーマッタ（Phase 5 最初の縦串）
- commit `7278f5f`（happy path）, `1afd65a`（空セグメント）— 2テスト追加、36テスト全緑
- **設計判断**: `format_session_markdown` は純粋関数。datetime整形は呼び出し元の責務とし、`chrono`/`time` 追加を先送り → 設計余地を残したまま前進できた
- **Markdownエスケープ方針は未定** — ユーザー入力（title, text）に `#`, `*`, 改行が混入した場合の扱い。次ループで方針決定
- **Phase 5 追加タスク**:
  - [ ] datetime整形ヘルパー（`format_started_at`, `format_segment_timestamp`）— `chrono` or `time` のどちらを採用するか決める
  - [ ] Markdownエスケープ方針の定義
  - [ ] マルチライン `text` の取り扱い（改行・インデント）
