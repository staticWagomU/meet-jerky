# RESEARCH: Transcript Export & Structuring

**対象**: yap（`refferencies/yap/`）から meet-jerky desktop 版へ移植する機能群の事前調査
**作成日**: 2026-04-20
**調査範囲**: `desktop/src-tauri/src/**`, `desktop/src/**`, `refferencies/yap/Sources/yap/**`

---

## 1. 背景と目的

yap は Apple Speech.framework（macOS 26+, Swift）ベースの CLI、meet-jerky desktop 版は whisper-rs + cpal + ScreenCaptureKit（Rust/Tauri）ベースの GUI。**コードはまったく流用できない**が、以下の4機能は仕様としての価値が高く、移植候補となる。

| # | yap 側の機能 | meet-jerky 現状 | 移植優先度 |
|---|---|---|---|
| 1 | 出力フォーマット（SRT/VTT/JSON/TXT） | `transcript.rs` が空のスタブ | **最優先** |
| 2 | 文分割（`splitAtTimeGaps` + `sentences(maxLength:)`） | 未実装。Whisper のセグメントをそのまま表示 | 高 |
| 3 | 話者ラベルのユーザー設定化（`--mic-label`/`--system-label`） | `"自分"/"相手"` ハードコード | 中 |
| 4 | `SCStreamConfiguration` ベストプラクティス | 既に `excludesCurrentProcessAudio(true)` 等は設定済み | **既存実装で充足** |

---

## 2. 現行コード調査結果

### 2.1 バックエンド（Rust / Tauri）

#### `desktop/src-tauri/src/lib.rs`
- 登録済み invoke ハンドラ: 17 個。音声・文字起こし・設定・権限まで一通り揃っている。
- **注目**: `transcript::*` のコマンドは一切登録されていない（`mod transcript;` 宣言はあるが中身は TODO コメント 1 行のみ）。エクスポート機能は完全に未着手。

#### `desktop/src-tauri/src/transcript.rs`
```rust
// TODO: Phase 4 で実装予定
```
- **唯一の1行**。モジュール宣言だけある状態。
- ここに yap の `OutputFormat.swift` を Rust に翻訳した実装を入れるのが自然なランディングポイント。

#### `desktop/src-tauri/src/transcription.rs`
- `TranscriptionSegment { text, start_ms, end_ms, speaker: Option<String> }` で結果を保持。タイムスタンプは既に ms 精度で揃っている。
- `run_transcription_loop` 内（`transcription.rs:590-709`）で 5 秒チャンクごとに Whisper 推論 → `transcription-result` イベントを emit。タイムスタンプは `chunk_count * 5000ms` のグローバルオフセットを加算（`transcription.rs:682-683`）。
- 話者ラベルは `speaker: Some("自分".to_string())` / `Some("相手".to_string())` でハードコード（`transcription.rs:426, 450`）。

#### `desktop/src-tauri/src/audio.rs` / `system_audio.rs`
- `AudioCapture` トレイトで `CpalMicCapture`（マイク）と `ScreenCaptureKitCapture`（システム音声）を抽象化。
- `system_audio.rs:97-103` で `excludesCurrentProcessAudio(true)`、`sample_rate = 48000`、`channel_count = 1` を指定済み。**yap の `SCStreamConfiguration` 相当は既に実装済み**。

#### `desktop/src-tauri/src/settings.rs`
- `AppSettings` に保存されているフィールド: `transcriptionEngine`, `whisperModel`, `microphoneDeviceId`, `language`, `outputDirectory`。
- 話者ラベル・出力フォーマット・最大文字数などはまだフィールド化されていない。
- `deserialize_engine_type_with_fallback` による「不正な enum でも他のフィールドを保持する」前方互換デザインが確立されている（最新 commit `1609ab9`）。→ 新フィールド追加時にも同じパターンを踏襲すれば既存ユーザーの設定を破壊しない。

### 2.2 フロントエンド（React / TypeScript）

#### `desktop/src/types/index.ts`
- `TranscriptSegment` は `speaker?: string` 型（union ではなく汎用 string）。話者ラベル変更には UI 側の型変更不要。
- `AppSettings` は上記 Rust 側とミラー。

#### `desktop/src/components/TranscriptDisplay.tsx`
- **既にコピー機能あり**（`handleCopyAll`, `TranscriptDisplay.tsx:84-101`）。フォーマットは `[MM:SS] 話者: text\n` 固定。
- 話者判定が `seg.speaker === "自分"` / それ以外の二分岐で CSS クラスを切り替え（`TranscriptDisplay.tsx:131-134, 150-155`）。**ラベルを設定で変更可能にするなら、この二分岐は「マイク由来 / システム音声由来」という意味論に組み替える必要がある**。
- ここが想定外の結合点。

#### `desktop/src/routes/TranscriptView.tsx`
- `segments: TranscriptSegment[]` をメモリ上に保持。Whisper の生セグメントを `handleNewSegment` でそのまま追加。
- **文分割は現状一切なし**。Whisper の 5 秒チャンクの自然な切れ目に依存。

---

## 3. 調査中の気付き（Findings）

### 気付き 3.1: yap の文分割は「2段構え」になっている
`splitAtTimeGaps(threshold: 1.5)` で **1.5 秒以上の無音ギャップで分割** → 各ブロックを `sentences(maxLength: 40)` で **文末+最大文字数で再分割**、という2パスアルゴリズム（`AttributedString+Extensions.swift:25-51, 53-109`）。

meet-jerky にこれを移植する場合、**Whisper の出力にはワード単位のタイムスタンプがない**（`transcription.rs:99-109` で segment 単位の start/end のみ取得）ため、完全な再現は不可。ただし Whisper の `FullParams` には `set_token_timestamps(true)` / `set_split_on_word(true)` 等のオプションがあり、それを有効化すれば `state.full_n_tokens(i)` + `get_segment_token_data` 経由でトークン時刻が得られる。**Whisper 側の params 調整が前提条件**。

代替案として、Whisper セグメント間の時間差（`prev.end_ms` と `next.start_ms` の差）を疑似ギャップとして扱う簡易版なら、既存データのみで実装可能。

### 気付き 3.2: yap の `OutputFormat` はストリーミング/バッファの2系統API
`OutputFormat.swift:44-116` に **ストリーミングAPI**（`header()`, `formatSegment()`, `footer`, `segmentSeparator`）、`OutputFormat.swift:118-168` に **バッファAPI**（`text(for:)`, `formatSegments(_:)`）がある。

meet-jerky はリアルタイム追記型なので、**ストリーミングAPI の構造がそのまま有効**。特に JSON 出力の場合、`header` で `{ "metadata": {...}, "segments": [`、各 segment を `,\n` 区切り、`footer` で `]\n}` を閉じる構造は、段階的ファイル書き込みでもそのまま使える。

**Rust 版では** `serde_json` で一括シリアライズするより、SRT/VTT と同じく手書きフォーマッタを採用した方が設計が揃う。JSON の "追記しながら書き出す" 要件も同じロジックで満たせる。

### 気付き 3.3: 既存の Copy 機能とエクスポート機能のフォーマット重複
`TranscriptDisplay.tsx:84-101` のコピー機能が既に独自フォーマット（`[MM:SS] speaker: text\n`）を持っている。エクスポート機能を追加する場合、**コピーボタンの出力もエクスポートフォーマットに統合**できる。

具体的には: TXT エクスポート実装時に「クリップボードへコピー」もフォーマット選択可能にすれば、UX に一貫性が出る。逆に現状のコピーフォーマットを残したまま別系統で SRT/VTT を追加すると、**フォーマット定義の重複**が発生する。

### 気付き 3.4: 話者ラベル変更は「表示ロジック」も影響する
`TranscriptDisplay.tsx:131-134` は `seg.speaker === "自分"` という**文字列等価比較**で CSS クラスを分岐している。話者ラベルをユーザー設定化すると、この判定が壊れる。

解決案:
- **(A)** `TranscriptSegment` に `source: "microphone" | "system_audio"` フィールドを追加し、表示用の `speaker` はラベル文字列、論理判定は `source` で行う。既存 `TranscriptionSegment`（Rust 側）のフィールド追加が必要。
- **(B)** 設定から取得した `micLabel` / `systemLabel` を TranscriptView に持たせて、`seg.speaker === micLabel` で比較する。ラベル変更の反映が動的に効くが、過去セグメントは古いラベルのまま残る。

**(A) の方がクリーン**。既存の camelCase serde 設計にも素直に乗る。

### 気付き 3.5: `transcript.rs` の "Phase 4 で実装予定" コメントは命名と合う
commit `12601a0` のメッセージに「設定永続化・設定画面・会議ボタン・権限バナー (Phase 4)」とあり、**Phase 4 のスコープには `transcript.rs` は入っていない**。つまりこの TODO は Phase 4 の定義からこぼれ落ちた残タスク。本ディレクトリ（`01_`）で最初に着手する機能として自然。

### 気付き 3.6: タイムスタンプの精度差
- yap: `CMTime`（秒 + timescale）→ SRT は `HH:MM:SS,mmm` の ms 精度
- meet-jerky: `start_ms: i64` / `end_ms: i64` → **既に ms 精度で揃っている**

yap の `srtTime()` / `vttTime()` の時刻変換ロジックはそのまま Rust に翻訳可能（浮動小数点からの変換が不要な分むしろシンプル）。

### 気付き 3.7: locale 情報の扱い
yap は `Locale` を JSON `metadata.language` / VTT ヘッダに出力（`OutputFormat.swift:53-59, 213-214`）。meet-jerky の `AppSettings.language` は `"auto" | "ja" | "en"` なので、JSON には BCP47 形式（`ja-JP` 等）に正規化して出すとプロトコル準拠度が上がる。細かいが移植時に見落としやすい。

### 気付き 3.8: `segmentSeparator` パターンは追記書き込みに最適
yap の `segmentSeparator`（`"\n\n"` for SRT/VTT, `,\n` for JSON）は、**「前のセグメントと次のセグメントの間にだけ挿入する」**という lazy 挿入戦略（`ListenAndDictate.swift:289-292` 参照）。meet-jerky が TranscriptSegment を逐次ファイルに書き出す設計にするなら、この「前の存在を知ってから区切りを書く」パターンがそのまま有効。

---

## 4. 移植対象機能の詳細マッピング

### 機能 4.1: 出力フォーマット（SRT/VTT/JSON/TXT）

**置き場所**: `desktop/src-tauri/src/transcript.rs`（現状スタブ）

**必要な型（提案）**:
```rust
pub enum OutputFormat { Txt, Srt, Vtt, Json }

pub struct ExportOptions {
    pub format: OutputFormat,
    pub output_path: PathBuf,
    pub mic_label: String,
    pub system_label: String,
    pub language: String,     // BCP47
    pub include_word_timestamps: bool,  // Whisper 側の params 調整次第
}
```

**対応する yap のコード**: `OutputFormat.swift` 全体。特に `srtTime()`/`vttTime()`/`jsonTime()` は純粋関数で移植容易。

**Tauri コマンド案**:
- `export_transcript(segments: Vec<TranscriptionSegment>, options: ExportOptions) -> Result<String, String>` … 一括エクスポート（現行の In-Memory segments を対象）
- 段階的には: まずバッファAPI（全セグメントを受け取って一括整形）、後からストリーミングAPI（録音中に追記書き込み）を追加するのが段階的に無理がない。

### 機能 4.2: 文分割

**置き場所候補**: `transcription.rs` の `run_transcription_loop` 内 or `transcript.rs` の後処理関数

**簡易版（Whisper 既存データのみ）**:
- `prev.end_ms` と `next.start_ms` の差が 1500ms 以上なら segment を「発話単位」として区切る。
- 最大文字数超過時は文字単位で分割（日本語は句点 `。`、英語は `.` で区切る）。

**本格版（Whisper params 調整）**:
- `FullParams::set_token_timestamps(true)` を有効化
- `state.full_n_tokens(i)` でトークン数、`state.full_get_token_data(i, j)` でトークンごとの `t0`/`t1` を取得
- yap の `wordTimestamps()` / `sentences()` を Rust で再実装

**推奨**: **簡易版から始める**。本格版は Whisper の推論時間増を招くため、実測後に判断。

### 機能 4.3: 話者ラベル設定化

**変更箇所**:

1. **`settings.rs`**: `AppSettings` に `mic_label: String`（default `"自分"`）, `system_label: String`（default `"相手"`）を追加。既存の `deserialize_engine_type_with_fallback` パターン同様、`default` 属性で旧設定ファイルとの互換性を保つ。

2. **`transcription.rs:426, 450`**: ハードコード `"自分"` / `"相手"` を `SettingsStateHandle` から読む実装に置換。

3. **`TranscriptSegment` に `source` フィールド追加**（気付き 3.4 の (A) 案）:
   ```rust
   pub enum AudioSource { Microphone, SystemAudio }
   pub struct TranscriptionSegment {
       pub text: String,
       pub start_ms: i64,
       pub end_ms: i64,
       pub speaker: Option<String>,     // 表示用
       pub source: Option<AudioSource>, // 論理判定用（新規）
   }
   ```

4. **`TranscriptDisplay.tsx:131-134`**: `seg.speaker === "自分"` を `seg.source === "microphone"` に置換。

5. **`SettingsView.tsx`**: 話者ラベル入力フィールドを追加。

### 機能 4.4: `SCStreamConfiguration`

**結論**: 既存実装（`system_audio.rs:97-103`）で **yap と同等の設定**が揃っている。追加作業なし。

念のため突き合わせ:

| 設定項目 | yap (`ListenAndDictate.swift`) | meet-jerky (`system_audio.rs`) |
|---|---|---|
| `capturesAudio` | `true` (L151) | `with_captures_audio(true)` (L100) |
| `excludesCurrentProcessAudio` | `true` (L154) | `with_excludes_current_process_audio(true)` (L101) |
| `sampleRate` | `sysFormat.sampleRate` (L152) | `48000` (L102) |
| `channelCount` | `sysFormat.channelCount` (L153) | `1` (L103) |
| `width / height` | `2 / 2` (L155-156) | `2 / 2` (L98-99) |
| `minimumFrameInterval` | `CMTime(1, 1)` (L157) | 未設定 |

**差分**: `minimumFrameInterval` のみ未設定。ビデオを使っていないので実害なし（フレームは取得しても使わない）が、CPU 節約目的で設定しておく価値はある。`screencapturekit` クレートの `with_minimum_frame_interval` に相当するメソッドがあるか要確認。

---

## 5. 実装順序の示唆

優先度順:

1. **`transcript.rs` に OutputFormat と SRT/VTT/JSON/TXT フォーマッタを実装**（気付き 3.2, 3.6, 3.7, 3.8）
   - 純粋関数のみで開始できる。TDD しやすい。
   - Tauri コマンド `export_transcript` を追加。
   - `TranscriptView.tsx` に「エクスポート」ボタンを追加し、`AppSettings.outputDirectory` へ書き出し。

2. **話者ラベル設定化**（気付き 3.4）
   - `TranscriptionSegment` に `source` フィールド追加 → フロント側 CSS 判定を移行。
   - 設定フィールド追加 → `SettingsView` UI 追加 → `transcription.rs` のハードコード置換。

3. **文分割（簡易版）**
   - Whisper の既存出力をセグメント間のギャップで再グルーピング。
   - エクスポート前処理としてのみ動作させ、リアルタイム表示には影響させない（UI 挙動を変えずに済む）。

4. **（オプション）コピー機能とエクスポートの統合**（気付き 3.3）
   - フォーマット選択可能なコピー機能に置き換え。
   - または「TXT コピー」「SRT コピー」など複数ボタン化。

5. **（オプション）文分割の本格版**
   - Whisper の token timestamps を有効化して yap と同等の精度を目指す。推論時間の実測後に判断。

---

## 6. 未解決事項

- Whisper に `set_token_timestamps` オプションを有効化した際の **推論時間インパクト**が不明。要ベンチマーク。
- JSON エクスポートを **ストリーミング追記**にする場合、途中でアプリが落ちたときの "閉じタグなし JSON" をどうリカバリするか。tmp ファイル + rename 戦略（`transcription.rs:184-215` のモデルダウンロードで既に採用）を踏襲するのが素直。
- 話者ラベルの **i18n**（将来的に英語 UI を出す場合、`"自分"/"相手"` のデフォルト値は `"Me"/"Other"` にすべきか）。現状の `AppSettings.language` は "文字起こし対象言語" であり UI 言語ではないので、別フィールドが要る場合あり。

---

## 7. 参考ファイル一覧

### yap 側
- `refferencies/yap/Sources/yap/OutputFormat.swift` — フォーマッタ本体
- `refferencies/yap/Sources/yap/Extensions/AttributedString+Extensions.swift` — 文分割
- `refferencies/yap/Sources/yap/ListenAndDictate.swift` — デュアルストリーム構成（参考のみ）

### meet-jerky 側
- `desktop/src-tauri/src/transcript.rs` — 実装予定地（現状スタブ）
- `desktop/src-tauri/src/transcription.rs:426, 450` — 話者ラベルハードコード箇所
- `desktop/src-tauri/src/settings.rs` — 設定追加先
- `desktop/src/types/index.ts` — 型ミラー
- `desktop/src/components/TranscriptDisplay.tsx:131-134` — CSS 分岐ロジック
- `desktop/src/routes/SettingsView.tsx` — 設定 UI 追加先
