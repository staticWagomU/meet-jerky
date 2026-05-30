# デバッグ用コントローラー窓 実装プラン

## 目的
挙動がバギーなオーバーレイ群を、本番と同じバックエンド経路で任意に発火させて
単体検証するための「コントローラー窓」を dev ビルド限定で追加する。

## 把握したアーキテクチャ（バグの温床候補）
- 各オーバーレイ窓（`meeting-prompt` / `live-caption` / `ring-light`）は起動時に
  **隠して全部生成済み**（`lib.rs setup_overlay_windows`）。表示は後から show/hide。
- どの UI を描画するかは URL の `?window=` ラベルで分岐（`main.tsx`）。
- **責務が分裂**している:
  - 会議検出: Rust(`app_detection.rs:198`) は `meeting-app-detected` を emit する**だけ**。
    窓表示は フロント `MeetingDetectedBanner.tsx:163` が自分で `set_meeting_prompt_window_visible(true)`。
  - 字幕/リングライト: 表示制御は `TranscriptView.tsx`（録音状態連動）、データは別イベント。
- → 「イベント emit」と「窓表示」が別レイヤー/別タイミング = 競合・順序・payload不一致が起きやすい。

## 設計方針（確定済み）
- 起動方式: **実バックエンド経路を叩く**（既存 command invoke ＋ 本番イベント emit）。
- 設置: **独立した中央コントローラー窓を新設**。
- 表示制御: **dev ビルド時のみ**（`cfg!(debug_assertions)`）。
- payload: **フロントサンプル ＋ Rust debug コマンド**（Rust の payload 構築経路も再現）。

## イベント/コマンド対応表（再現レシピ）
| UI | 叩くもの |
|---|---|
| 会議検出 | `invoke debug_emit_meeting_detected({kind})`（Rust経路）／ `set_meeting_prompt_window_visible` |
| ライブ字幕 | `set_live_caption_window_visible` ＋ emit `live-caption-status`/`transcription-result`/`transcription-error` |
| リングライト | `set_ring_light_visible` ＋ emit `ring-light-mode-changed {mode}` |
| メイン窓 | `show_main_window` ／ emit `meet-jerky-start-recording-requested` |

## 有効サンプル payload（既存バリデータ準拠）
- 検出(app): `{source:"app", bundleId:"us.zoom.xos", appName:"zoom.us"}`
- 検出(browser): `{source:"browser", bundleId:"com.google.Chrome", appName:"Google Chrome", service:"Google Meet", urlHost:"meet.google.com", browserName:"Google Chrome"}`
- 字幕結果: `{text, startMs:0, endMs:1500, source:"microphone", speaker:"自分"}`
- 字幕ステータス: `{engineLabel:"Whisper", aiTransmissionLabel:"なし", isExternalTransmission:false, transcriptionStatusLabel:"文字起こし中", microphoneTrackLabel:"録音中", systemAudioTrackLabel:"録音中"}`
- 字幕エラー: `{error:"テストエラー", source:"system_audio"}`
- リングライト: `{mode:"soft"|"bright"|"off"}`

## 変更ファイル
1. `src-tauri/src/app_detection.rs` — `debug_emit_meeting_detected`(cfg debug) ＋ cargo 単体テスト
2. `src-tauri/src/lib.rs` — controller 窓生成(cfg debug)・コマンド登録(cfg debug)
3. `src-tauri/capabilities/default.json` — `windows` に `"controller"` 追加
4. `src/main.tsx` — `controller` ラベル分岐
5. `src/components/ControllerWindow.tsx` — 新規（ボタン群＋実行結果表示）
6. `src/utils/controllerActions.ts` — 型付きサンプル payload ＋ アクション関数
7. `src/App.css` — controller 用スタイル（最小）
8. `src-tauri/tauri.conf.json` — beforeDev/BuildCommand を bun へ修正（bun移行の取りこぼし）

## 検証
- Rust: `cargo test`（debug コマンドの payload 構築）
- フロント: 型はサンプルを公開 interface に対して型付け → `tsc` で静的保証（desktop に vitest 無し）
- 手動: `bun run tauri dev` で controller 窓を起動しボタン動作確認

## TDD 上の注記
desktop にテストランナーが無いため、フロントは型レベル保証＋手動確認、Rust は cargo test。
本格的な TDD には vitest 導入が必要だが、デバッグ用ツールにつき今回はスコープ外とする。
