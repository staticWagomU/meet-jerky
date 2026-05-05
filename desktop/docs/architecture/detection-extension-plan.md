# 検知拡張 Plan = Slack Huddle / Discord stage / 補助 service

> **作成**: mjc-main-20260505-35 Loop 71 (2026-05-05 JST)
> **目的**: AGENTS.md priority 2 (会議サービス検知) の段階的拡張に向けた設計プラン
> **状態**: ドラフト (実装未着手、後続 Loop で Phase 1 から段階導入)

## 1. Overview

meet-jerky は現在、macOS のネイティブアプリとして Zoom / Microsoft Teams (新旧) / FaceTime の 4 サービスを bundle ID で検知し、ブラウザ会議は Webex / Whereby / GoToMeeting / Zoom Web / Microsoft Teams Web / Google Meet の 6 サービスを URL pattern で検知している。加えて window title 経路 (`classify_meeting_window_title`) も実装済みで Google Meet / Zoom / Webex の 3 サービスに対応する。

拡張要望として Slack Huddle・Discord stage が挙げられている。これらはデスクトップアプリが主流だが、単純に bundle ID を `WATCHED_BUNDLE_IDS` に追加するだけでは「Slack/Discord を起動した = 会議中」と誤検知する。両サービスはアプリを常時起動したまま使うユーザーが多く、bundle ID のみによる検知は false positive 率が極めて高い。よって **window title pattern matching による会議状態識別** が必須となる。

本 plan では現状把握 (Section 2) → 拡張対象の要件整理 (Section 3) → 検知戦略 (Section 4) → Phase 1-5 の段階設計 (Section 5) → 要検証項目 (Section 6) の順で記述する。`docs/architecture/transcription-refactor-plan.md` (Phase 1-6 完全完遂) と同一の Phase 設計 pattern を踏襲する。

## 2. Current State (現状把握)

### 2.1 WATCHED_BUNDLE_IDS const (調査 1 結果)

```rust
const WATCHED_BUNDLE_IDS: &[(&str, &str)] = &[
    ("us.zoom.xos", "Zoom"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("com.microsoft.teams", "Microsoft Teams"),  // 旧 Teams (legacy Electron)
    ("com.apple.FaceTime", "FaceTime"),
];
```

型は `&[(&str, &str)]` = `(bundle_id, display_name)` の 2-tuple。現状は MatchStrategy の概念を持たず、bundle ID が前面に出た瞬間に会議開始と判定する。

| bundle_id | 表示名 |
|-----------|--------|
| `us.zoom.xos` | Zoom |
| `com.microsoft.teams2` | Microsoft Teams |
| `com.microsoft.teams` | Microsoft Teams (旧) |
| `com.apple.FaceTime` | FaceTime |

### 2.2 検知経路 (3 系統)

`throttle_key` の形式が経路を区別する:

| 経路 | throttle_key 形式 | 判定場所 |
|------|------------------|---------|
| bundle_id 単独 | `"<bundle_id>"` 例: `"us.zoom.xos"` | `handle_detection` (行 137) |
| ブラウザ URL | `"browser:<host_or_service>"` | `handle_browser_url_detection` (行 311) |
| window title | `"window-title:<bundle_id>:<service>"` | `handle_browser_url_detection` (行 363-365) |

`parse_throttle_key_to_display_name` (行 470) がこの 3 形式をすべて解釈し表示名へ変換する。

### 2.3 window title 検知 (調査 2 結果)

`classify_meeting_window_title` (行 574) が**フル実装済み**。現在の対応パターン:

| サービス | 検知 prefix |
|---------|------------|
| Google Meet | `"Meet - "` / `"Meet \u{2013} "` / `"Meet \u{2014} "` |
| Zoom | `"Zoom Meeting"` / `"Zoom ミーティング"` (prefix 一致) |
| Webex | `"Webex Meeting"` (prefix 一致) |

実装経路: `handle_browser_url_detection` が url/title を受け取り、URL が会議 URL でない場合に `classify_meeting_window_title(window_title)` をフォールバックとして呼ぶ。throttle_key は `format!("window-title:{bundle_id}:{}", c.service)` で生成される。

Slack / Discord / その他サービスの window title pattern は**未実装**。

### 2.4 ブラウザ URL 経路の既存サービス別 module (調査 3 結果)

```
src-tauri/src/app_detection_google_meet.rs   (1009 B)
src-tauri/src/app_detection_goto.rs          (2688 B)
src-tauri/src/app_detection_teams.rs         (1997 B)
src-tauri/src/app_detection_url_helpers.rs   ( 882 B)
src-tauri/src/app_detection_webex.rs         (2816 B)
src-tauri/src/app_detection_whereby.rs       (1200 B)
src-tauri/src/app_detection_zoom.rs          (1516 B)
```

合計 7 file (url_helpers 込み)。各 file に `classify_*_url` 関数と axis test が分離されている。新サービス追加時は `app_detection_<service>.rs` を新規作成するパターンが確立している。

### 2.5 Slack / Discord の現状 (調査 4 結果)

`src-tauri/src/` 内に `slack` / `discord` / `huddle` / `stage` の言及は**ゼロ**。
`docs/` 内では `loop63` (後続機会列挙) と `loop71` (本プロンプト) のみで言及されており、実装着手は今回初。

## 3. Target Services (拡張対象)

### 3.1 Slack Huddle

| 項目 | 値 |
|------|-----|
| bundle_id | `com.tinyspeck.slackmacgap` |
| 検知経路 | window title (デスクトップアプリ主流) |
| window title 例 | `"Huddle in #general (3) - Slack"` など (要実機確認) |
| web URL 例 | `app.slack.com/...` (huddle 中 URL 形式は不明、要検証) |
| 課題 | Slack は常時起動が多い = bundle ID 単独では全起動を誤検知 |
| 識別条件 (仮) | window title に `"Huddle"` を含む |

Slack デスクトップアプリの window title は通常 `"ワークスペース名 - Slack"` 等。Huddle 中は `"Huddle in #channel"` 形式に変化すると推測されるが実機確認が必要。日本語表示では `"ハドル中 #general"` 等になる可能性もある。

### 3.2 Discord stage

| 項目 | 値 |
|------|-----|
| bundle_id | `com.hnc.Discord` |
| 検知経路 | window title (デスクトップアプリ) + ブラウザ URL (web 版) |
| window title 例 | `"#stage-channel / Stage - Server Name - Discord"` など (要実機確認) |
| web URL 例 | `discord.com/channels/<guild-id>/<channel-id>` (stage channel の URL 形式は通常チャンネルと同一の可能性) |
| 課題 | Discord も常時起動が多い + stage URL と通常チャンネル URL が同形式の可能性 |
| 識別条件 (仮) | window title に `"Stage"` を含む |

Discord は "Stage Channel" という専用チャンネル型。URL ではなく window title のほうが信頼性が高い可能性がある。

### 3.3 補助サービス (低優先)

| サービス | 課題 | 対応方針 |
|---------|------|---------|
| MS Teams Channel Calls | 既存 `com.microsoft.teams2` と同一 bundle、call/非call の状態識別が困難 | 低優先 backlog |
| Zoom Phone | 既存 `us.zoom.xos` と同一 bundle、phone/meeting の識別が困難 | 低優先 backlog |
| Google Meet (デスクトップアプリ) | PWA 形式のため bundle ID 不安定 | ブラウザ URL 経路で対応済みにつき不要 |

## 4. Detection Strategy (検知戦略)

### 4.1 推奨経路選択

| サービス | 推奨経路 | 理由 |
|---------|---------|------|
| Slack Huddle | window title | デスクトップアプリ主流、URL は huddle 状態を示さない可能性が高い |
| Discord stage | window title (主) + web URL (副) | window title が最も信頼性が高い。web 版は URL 形式の調査次第 |

### 4.2 既存基盤の活用範囲

調査 2 の結果から、window title 経路は**既にフルインフラ実装済み**。

追加実装が必要な作業:
1. `WATCHED_BUNDLE_IDS` の型拡張 = `MatchStrategy` enum 導入 (Phase 1)
2. `classify_meeting_window_title` に Slack Huddle / Discord stage の pattern 追加 (Phase 2)
3. 新サービス用 axis test の追加 (Phase 2-3 と連動)

`app_detection_window_title.rs` の新規作成は任意 (規模次第)。現状 `classify_meeting_window_title` は `app_detection.rs` 本体に約 30 行で収まっているため、Slack/Discord を追加しても 50-60 行程度であれば分離しなくてよい。

### 4.3 window title pattern の検証前提

`classify_meeting_window_title` への pattern 追加は**実機確認後**が望ましい。Open Questions (Section 6) に記載した window title 実例の収集が先行タスクとなる。実例なしに実装すると false negative (会議中なのに検知されない) または false positive (会議外なのに検知される) が生じる。

## 5. Phase Plan (段階設計)

### Phase 1: WATCHED_BUNDLE_IDS 構造拡張 = MatchStrategy 導入 (規模 SS)

**目的**: bundle ID 単独で会議と判定するアプリ (Zoom/Teams/FaceTime) と、window title が必要なアプリ (Slack/Discord) を型で区別できるようにする。

**変更内容**:

```rust
// 新規 enum (app_detection.rs 内または新 file)
#[derive(Debug, Clone)]
enum MatchStrategy {
    AppLaunch,                           // bundle ID 前面で即会議と判定 (既存動作)
    WindowTitleContains(&'static str),   // window title に指定文字列を含む場合のみ
}

// WATCHED_BUNDLE_IDS の型変更
const WATCHED_BUNDLE_IDS: &[(&str, &str, MatchStrategy)] = &[
    ("us.zoom.xos", "Zoom", MatchStrategy::AppLaunch),
    ("com.microsoft.teams2", "Microsoft Teams", MatchStrategy::AppLaunch),
    ("com.microsoft.teams", "Microsoft Teams", MatchStrategy::AppLaunch),
    ("com.apple.FaceTime", "FaceTime", MatchStrategy::AppLaunch),
];
```

**既存動作への影響**: `AppLaunch` は現在の bundle ID 単独判定と完全互換。既存 4 アプリの振る舞いは不変。

**テスト追加**: `MatchStrategy` の単体 test 3-5 件 + 既存 702 件全 pass 維持確認。

**想定 elapsed**: 1 ループ (~10-15 分)

---

### Phase 2: window title pattern 追加 = Slack Huddle / Discord stage (規模 S)

**前提**: Phase 1 完了 + Section 6 の window title 実例収集完了。

**変更内容**:

```rust
// classify_meeting_window_title への追加 (パターンは実機確認後に決定)
// Slack Huddle: "Huddle" / "ハドル" prefix または含有
// Discord stage: "Stage Channel" suffix など (要確認)
```

`WATCHED_BUNDLE_IDS` に Slack / Discord を追加:

```rust
("com.tinyspeck.slackmacgap", "Slack Huddle", MatchStrategy::WindowTitleContains("Huddle")),
("com.hnc.Discord", "Discord Stage", MatchStrategy::WindowTitleContains("Stage Channel")),
```

`handle_detection` 内で `MatchStrategy::WindowTitleContains(pat)` の場合に window title を取得して pattern 照合するロジックを追加。

**サービス別 file**: `app_detection_slack.rs` / `app_detection_discord.rs` を新規作成 (axis test + pattern 定数を分離)。分離するかどうかは実装規模次第 (20 行超なら分離推奨)。

**テスト追加**: Slack Huddle 検知 axis test / Discord stage 検知 axis test + false positive test (通常 Slack/Discord 起動では検知しないこと)。

**想定 elapsed**: 1-2 ループ (実機確認 + 実装込み)

---

### Phase 3: Slack web 版 Huddle 対応 (規模 SS-S、任意)

**前提**: Phase 2 完了 + `app.slack.com` 上での Huddle 中 URL 形式の調査完了。

Slack web 版で Huddle 中の URL が識別可能な形式 (例: `/huddle` path など) であれば `classify_meeting_url` に追加。識別不可能な場合は backlog 化。

`app_detection_slack.rs` に `classify_slack_url` を追加するパターン (`app_detection_google_meet.rs` precedent)。

**想定 elapsed**: 1 ループ (調査結果次第でスキップ可能)

---

### Phase 4: Discord web 版 stage 対応 (規模 SS-S、任意)

**前提**: Phase 2 完了 + `discord.com/channels/` URL から stage channel か否かを識別できるかの調査完了。

Discord の stage channel URL は通常チャンネルと同形式 (`discord.com/channels/<guild>/<channel>`) の可能性が高く、URL のみでの識別は困難な見込み。識別不可能な場合は Phase 2 の window title 経路のみで対応完了とする。

**想定 elapsed**: 1 ループ (調査次第でスキップ)

---

### Phase 5: 補助サービス + frontend 対応 (低優先)

- MS Teams Channel Calls / Zoom Phone: 同一 bundle 内での状態識別が困難な場合は backlog へ。Apple Script / Accessibility API 経由での状態取得が技術的解決策として考えられるが工数が大きい。
- `src/components/MeetingDetectedBanner.tsx` (526 行): Slack Huddle / Discord stage のアイコン追加対応 (Phase 2 完了後のフォローアップ)。
- 日本語 window title 対応: `"ハドル中"` / `"ステージ"` 等の日本語 pattern 追加 (実機確認後)。

**想定 elapsed**: 複数ループ (優先度が上がった時点で実施)

### Phase 状態 (mjc-main-20260505-42 Loop 84 時点)

| Phase | 状態 | 待ち / 前提 | 想定再開 trigger |
|-------|------|-------------|------------------|
| Phase 1 | **完了** (mjc-main-20260505-36 Loop 72) | - | - (再開不要) |
| Phase 2 | **未着手** | Q1/Q2 = 実機 (Slack デスクトップで huddle / Discord デスクトップで stage 参加) で window title を AppleScript 取得 | Q1/Q2 が解決 (実機実例の plan 取り込み) |
| Phase 3 | **未着手 (任意)** | Phase 2 完了 + Q3 (Slack web 版 huddle 中 URL 形式の実機確認) | Phase 2 完了後、ユーザーから web 版 Slack 利用要望 |
| Phase 4 | **未着手 (任意、識別困難見込み)** | Phase 2 完了 + Q4 (Discord web 版 stage URL 形式) = URL のみで識別困難の見込み | Phase 2 完了後、URL 識別可能性が確認できた場合 |
| Phase 5 | **未着手 (後追い)** | 補助サービス (MS Teams Channel Calls / Zoom Phone) + 日本語 window title pattern + frontend アイコン (`MeetingDetectedBanner.tsx`) | Phase 2 完了 + 優先度上昇 (ユーザーフィードバック蓄積後) |

**着手判断方針**:

- 単独 main agent はメイン批判的判断の範囲で `docs/architecture/detection-extension-plan.md` の追記 / Q5/Q6 のような Resolved Block 起こしは可能だが、**Phase 2 以降の rust 実装着手は Q1/Q2 実機確認が前提**。実機確認なしの推測 pattern (例: 推測値 `"Huddle"` のみで着手) は実装の false positive リスクが残るため backlog 化が安全側。
- Q1/Q2 解決時点で Phase 2 着手 (Phase 2 内手順は Section 5 Phase 2 = `**実装内容**` の段に既記載)。

## 6. Open Questions (要検証項目)

| # | 質問 | 重要度 | 確認方法 |
|---|------|--------|---------|
| Q1 | Slack Huddle 中の window title 実例 (英語 / 日本語) | 高 (Phase 2 前提) | macOS + Slack デスクトップアプリで huddle 参加後に AppleScript で取得 |
| Q2 | Discord stage channel 中の window title 実例 | 高 (Phase 2 前提) | macOS + Discord デスクトップアプリで stage 参加後に AppleScript で取得 |
| Q3 | Slack web 版の huddle 中 URL 形式 | 中 (Phase 3 前提) | ブラウザで huddle 参加後に URL バーを確認 |
| Q4 | Discord web 版の stage channel URL 形式 | 中 (Phase 4 前提) | ブラウザで stage 参加後に URL バーを確認 |
| Q5 | `MatchStrategy::WindowTitleContains` の serde 影響範囲 | 解決済 (下記参照) | `WATCHED_BUNDLE_IDS` が serde Serialize/Deserialize の対象かを `grep -n serde` で確認 |
| Q6 | window title の日本語 localization 対応方針 | 解決済 (下記参照) | `"Huddle"` → `"ハドル中"` 等の prefix/含有 pattern を追加するか英語のみとするか |
| Q7 | Discord `com.hnc.Discord` bundle ID の正確な値 | 低 | `mdls -name kMDItemCFBundleIdentifier /Applications/Discord.app` で確認 |
| Q8 | Slack bundle ID の正確な値 | 低 | `mdls -name kMDItemCFBundleIdentifier /Applications/Slack.app` で確認 |

### Q5 解決結果 (mjc-main-20260505-37 Loop 74 調査)

**結論**: `MatchStrategy::WindowTitleContains` 拡張による外部 API への影響は **なし**。

**根拠**:
- `WATCHED_BUNDLE_IDS` は `app_detection.rs` 内の `const &[(&str, &str, MatchStrategy)]` で定義されており、外部 module / 外部 crate に直接 serialize されない。
- `app_detection.rs` の serde 利用箇所は `MeetingAppDetectedPayload` enum (L74-103, struct field 単位の `#[serde(rename = ...)]`) と test 内の `serde_json::to_string(&bundle_ids)` (L841) のみ。後者は `Vec<&str>` 型 = bundle_id 文字列のみを抽出した flat 配列を serialize しており、`MatchStrategy` enum 自体は serialize 対象に含まれない。
- `MatchStrategy` enum は `Debug + Clone + PartialEq + Eq` のみ derive され、`Serialize` / `Deserialize` 未実装。WindowTitleContains variant 追加で外部 IPC payload 形状は変化しない。

**Phase 2 着手判断への寄与**: Phase 2 で WATCHED_BUNDLE_IDS に Slack/Discord エントリを追加する際、frontend / Tauri IPC 側の payload schema 変更は不要 = 後方互換性確保。

### Q6 解決結果 (mjc-main-20260505-39 Loop 78 調査)

**結論**: window title 日本語 localization 対応は **段階導入方針**。Phase 2 では英語 pattern only で着手し、Phase 5 で日本語 pattern (`"ハドル中"` / `"ステージ"` 等) を追加する。

**根拠**:
- Section 5.5 Phase 5 (L230) で「日本語 window title 対応: `"ハドル中"` / `"ステージ"` 等の日本語 pattern 追加 (実機確認後)」が既に Phase 5 タスクとして記載されており、段階導入方針は plan 内既存。
- Section 3.1 Slack Huddle (L95) で「日本語表示では `"ハドル中 #general"` 等になる可能性」、Q1 (L238) で「英語 / 日本語」両方の実機確認指示が既に明記されており、日本語追加は Phase 5 着手前提として保持されている。
- false negative (日本語環境ユーザーで huddle 中の検知漏れ) は無害な失敗 = 「会議検知 banner が出ない」だけで誤録音・誤通知は発生しない。一方 false positive (日本語 window title が会議外と誤マッチ) のリスクは英語 only ならゼロ = 段階導入は安全側に倒す方針として妥当。

**Phase 2 着手判断への寄与**: Phase 2 は英語 pattern (`"Huddle"` / `"Stage Channel"`) のみで実装着手 OK = Q1/Q2 (英語 window title 実機確認) が解決すれば即進められる。日本語 pattern 追加は Phase 5 でユーザーフィードバック蓄積後に対応 = MVP リリース時点の対応コスト最小化。

### AppleScript による window title 取得コマンド (参考)

```applescript
-- Slack の window title 一覧を取得
tell application "Slack"
    set windowNames to name of every window
end tell
return windowNames
```

```bash
# CLI から実行
osascript -e 'tell application "Slack" to name of every window'
osascript -e 'tell application "Discord" to name of every window'
```

## 7. 参考

- `docs/architecture/transcription-refactor-plan.md` (Phase 1-6 完全完遂 precedent、47KB)
- `src-tauri/src/app_detection.rs` (WATCHED_BUNDLE_IDS 行 33 / handle_detection 行 137 / classify_meeting_window_title 行 574)
- `src-tauri/src/app_detection_*.rs` 7 件 (サービス別 module / axis test 分離 precedent)
- AGENTS.md priority 2: 会議サービス検知 (Slack Huddle / Discord stage 等の段階拡張)
