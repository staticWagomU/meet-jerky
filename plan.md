# Google Meet Transcript Clipper - 調査結果

## 1. Google MeetのDOM構造

### 1.1 字幕(CC)ボタン

Google Meetの字幕ボタンをプログラムで操作するための方法は2つある。

**方法A: Material Iconsのテキストコンテンツで検索**
TranscripTonicが採用している方法。Google Meetには2つのUIバージョンがある。

```javascript
// UI v1: .material-icons-extended クラスの要素内テキストが "closed_caption_off"
// UI v2: .google-symbols クラスの要素内テキストが "closed_caption_off"
```

TranscripTonicは `selectElements(selector, text)` というヘルパー関数を使い、セレクタとテキスト内容の両方でマッチする要素を取得している。

**方法B: aria-labelで検索**
```javascript
// 英語UI
document.querySelector('button[aria-label="Turn on captions"]');
// 日本語UI
document.querySelector('button[aria-label="字幕をオンにする"]');
```

**方法C: キーボードショートカット**
Recall.aiのbotが使う方法。`Shift+C` でキャプションのオン/オフを切り替えられる。
UIセレクタの変更に左右されないため、最も安定している。

### 1.2 字幕テキストコンテナ

字幕が有効になると、Google Meetは `role="region"` 属性を持つ `<div>` 要素にキャプションを表示する。

**安定セレクタ（aria属性ベース）:**
```javascript
// Recall.aiが使用 - 比較的安定
document.querySelector('div[role="region"][aria-label="Captions"]');
```

**TranscripTonicが使用:**
```javascript
document.querySelector('div[role="region"][tabindex="0"]');
```

**難読化されたクラス名ベースのセレクタ（不安定・頻繁に変更される）:**

| セレクタ | 用途 | 出典 |
|----------|------|------|
| `.nMcdL` | キャプション行の親コンテナ | Recall.ai |
| `.ygicle` | キャプションテキストノード | Recall.ai |
| `.NWpY1d` | 発言者名バッジ | Recall.ai, Recall.aiブログ |
| `.xoMHSc` | 発言者名バッジ（代替） | Recall.aiブログ |
| `.iTTPOb` | キャプションテキストノード | Meet-Script |
| `.zs7s8d.jxFHg` | 発言者名 | Meet-Script, alert-me-google-meet |
| `.CNusmb` | サブタイトルテキストノード | alert-me-google-meet |
| `.KpxDtd.r6DyN` | 発言者プロフィール画像 | alert-me-google-meet |

**注意:** これらのクラス名はGoogleの難読化/圧縮によるもので、UIアップデートごとに変更される可能性がある。

### 1.3 字幕テキスト要素（誰が何を言ったか）

キャプションのDOM構造は以下の階層になっている:

```
div[role="region"][aria-label="Captions"]  ← キャプション領域全体
  └── div.nMcdL (キャプション行コンテナ)
        ├── [発言者名要素] .NWpY1d  ← textContentで名前を取得
        └── [テキスト要素] .ygicle  ← textContentでキャプションテキストを取得
```

**発言者名の取得:**
```javascript
// Recall.ai方式
const speakerName = captionLine.querySelector('.NWpY1d')?.textContent?.trim();
// または data-participant-id属性
const participantId = captionLine.getAttribute('data-participant-id') || speakerName;

// TranscripTonic方式（DOMの親子関係をたどる）
const currentPersonName = mutationTarget.parentElement?.previousSibling?.textContent;
```

**キャプションテキストの取得:**
```javascript
// Recall.ai方式
const text = captionLine.querySelector('.ygicle')?.textContent;

// TranscripTonic方式
const currentTranscriptText = mutationTarget.parentElement?.textContent;
```

### 1.4 通話終了ボタン

```javascript
// aria-labelで検索（最も信頼性が高い）
document.querySelector('[aria-label="Leave call"]').click();
// 日本語UI
document.querySelector('[aria-label="通話から退出"]').click();

// Material Iconsのテキストコンテンツで検索（TranscripTonic方式）
// .google-material-icons または .google-symbols クラスの要素内テキストが "call_end"
// → parentElement.parentElement で実際のボタン要素を取得

// 複数のバリエーションに対応（Recall.aiブログ方式）
const hangUpSel = 'button[aria-label*="Leave call"], button[aria-label*="Leave meeting"]';
// フォールバック: Ctrl+Alt+Q キーボードショートカット
```

### 1.5 その他のUI要素

```javascript
// チャットメッセージコンテナ
'div[aria-live="polite"].Ge9Kpc'

// チャットアイコン
// .google-symbols テキスト "chat"

// ユーザー名（会議前）
'.awLEm'

// 会議タイトル
'.u6vdEc'

// 会議中であることの検出
'div[jscontroller="kAPMuc"]'   // コールコントロールバーの存在
'div[jscontroller="TEjq6e"]'   // 字幕/キャプション表示パネル
```

---

## 2. MutationObserverのパターン

### 2.1 2段階のObserverパターン（推奨）

```typescript
// ステップ1: キャプション領域の出現を監視
const bodyObserver = new MutationObserver(() => {
  const region = document.querySelector<HTMLElement>(
    'div[role="region"][aria-label="Captions"]'
  );
  if (region) {
    bodyObserver.disconnect();
    attachCaptionObserver(region);
  }
});
bodyObserver.observe(document.body, { childList: true, subtree: true });

// ステップ2: キャプション領域内の変更を監視
function attachCaptionObserver(region: HTMLElement) {
  const captionObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      // 新しいキャプション行が追加されたとき
      mutation.addedNodes.forEach(node => {
        if (node instanceof HTMLElement && node.matches('.nMcdL')) {
          processCaptionLine(node);
        }
      });
    });
  });
  captionObserver.observe(region, { childList: true, subtree: true });
}

// ステップ3: 個別テキストノードの更新を監視（リアルタイム更新用）
function watchTextNode(txtNode: HTMLElement) {
  new MutationObserver(() => {
    // テキストが更新された（Googleは単語ごとに追加していく）
    processUpdatedText(txtNode);
  }).observe(txtNode, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
```

### 2.2 Observer設定オプション

```javascript
const mutationConfig = {
  childList: true,     // 子ノードの追加/削除を検出
  attributes: true,    // 属性変更を監視
  subtree: true,       // すべての子孫を監視
  characterData: true, // テキスト内容の変更を追跡
};
```

---

## 3. 重複排除ロジック

Googleはキャプションを段階的に表示する（単語ごとに追加）ため、重複排除が必要。

```typescript
// Recall.ai方式: 正規化して比較
const normalize = (text: string) => text.replace(/[^\w\s]/g, '').trim().toLowerCase();
const lastSeen = new Map<string, string>();

function deduplicate(speakerKey: string, text: string): boolean {
  const norm = normalize(text);
  const prev = lastSeen.get(speakerKey);
  if (prev === norm) return false; // 重複 - スキップ
  lastSeen.set(speakerKey, norm);
  return true; // 新しいテキスト
}

// Recall.aiブログ方式: テキストの成長を検出
const activeSegments = new Map<string, Segment>();

function processCaption(speaker: string, caption: string) {
  const existing = activeSegments.get(speaker);
  if (!existing) {
    activeSegments.set(speaker, { speaker, text: caption, start: Date.now() });
  } else {
    // テキストが成長している場合のみ更新
    if (caption.startsWith(existing.text) || caption.length > existing.text.length + 5) {
      existing.text = caption;
      existing.end = Date.now();
    }
  }
}
```

---

## 4. Shadow DOMとiframeについて

**結論: Google Meetはキャプション要素にShadow DOMやiframeを使用していない。**

- すべてのキャプション要素は通常のlight DOMに直接レンダリングされる
- コンテンツスクリプトから直接 `document.querySelector` でアクセス可能
- TranscripTonic、Recall.ai、Meet-Scriptのいずれも、Shadow DOM piercing（`::part`, `::slotted`）やiframeトラバーサルのコードを含んでいない
- ただし、Chrome拡張機能自体のUIをGoogle Meetページのスタイルから隔離するために、Shadow DOMを使用することが推奨される（WXTの `createShadowRootUi` が対応）

---

## 5. 既知の課題と注意点

### 5.1 セレクタの不安定性
- Googleは頻繁にUIアップデートを行い、クラス名やaria-roleが変更される
- 難読化されたクラス名（`.nMcdL`, `.ygicle` 等）は特に不安定
- `aria-label` ベースのセレクタが最も安定しているが、ロケールごとに異なる
- キーボードショートカット（`Shift+C`）がUI変更に最も影響を受けにくい

### 5.2 キャプションの品質
- Googleは積極的に言い換え（パラフレーズ）を行い、長いフレーズを切り詰め、句読点を省略する
- 精度は約90%
- クロストーク、ぼそぼそ話、多言語の会話ではキャプションが欠落する可能性がある
- 同一行の再送出・フラグメントが発生するため、保存前に重複排除が必要

### 5.3 キャプション履歴の変更（2025年2月）
- 以前はキャプションが一時的に表示されて消えていた
- 2025年2月から、過去30分のキャプション履歴をスクロールで確認可能になった
- このUIアップデートによりDOMの構造が変更されている可能性がある

### 5.4 カスタマイズ可能なキャプションスタイル（2025年6月）
- Google Meetがキャプションのスタイルカスタマイズ機能を追加
- これもDOMの構造に影響している可能性がある

### 5.5 言語制限
- Google Meetは同時に1つのキャプション言語のみレンダリング可能
- メニューで言語を切り替えることは可能だが、自動マルチ言語ストリームはない

### 5.6 システムメッセージのフィルタリング
```javascript
// システムメッセージを除外する
if (/you left the meeting|return to home screen/i.test(text)) {
  return; // キャプションではない
}
```

---

## 6. 実装の推奨アプローチ（WXT + content script）

このプロジェクトはWXTフレームワークを使用しているため、以下の構成が推奨される:

```typescript
// entrypoints/content.ts
export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    // 1. 会議に参加していることを検出
    // 2. キャプションを有効化（Shift+Cが最も安定）
    // 3. MutationObserverでキャプション領域を監視
    // 4. 発言者名とテキストを抽出
    // 5. 重複排除してストレージに保存
    // 6. 会議終了を検出してクリーンアップ
  },
});
```

### キャプション有効化の推奨方法

```typescript
// キーボードショートカット方式（最も安定）
function enableCaptions() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'c',
    shiftKey: true,
    bubbles: true,
  }));
}

// または、要素が見つかるまで待機してクリック
async function waitAndEnableCaptions() {
  const btn = await waitForElement(
    () => {
      // Material Iconsで検索
      const icons = document.querySelectorAll('.google-symbols, .material-icons-extended');
      for (const icon of icons) {
        if (icon.textContent?.trim() === 'closed_caption_off') {
          return icon.closest('button');
        }
      }
      return null;
    }
  );
  btn?.click();
}
```

---

## 7. 参考プロジェクト

| プロジェクト | URL | 特徴 |
|-------------|-----|------|
| TranscripTonic | https://github.com/vivek-nexus/transcriptonic | 最も活発にメンテナンスされている。Google Meet/Zoom/Teams対応 |
| Recall.ai Chrome Extension | https://github.com/recallai/chrome-recording-transcription-extension | TypeScript。scrapingScript.tsが参考になる |
| Meet-Script | https://github.com/RutvijDv/Meet-Script | シンプルな実装。jscontrollerベースのセレクタ |
| alert-me-google-meet | https://github.com/heytulsiprasad/alert-me-google-meet | キーワードアラート。キャプション監視の参考 |
| Recall.ai Bot（ブログ記事） | https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot | Playwright bot。詳細な実装解説 |

---

## 8. セレクタの優先度ガイドライン

セレクタの安定性は以下の順:

1. **キーボードショートカット** (`Shift+C`, `Ctrl+Alt+Q`) - UI変更に影響されにくい
2. **aria属性** (`[aria-label="Captions"]`, `[role="region"]`) - 比較的安定
3. **Material Icon テキスト** (`closed_caption_off`, `call_end`) - アイコン名は安定
4. **data属性** (`data-participant-id`) - 存在が保証されない
5. **難読化クラス名** (`.nMcdL`, `.ygicle`) - 最も不安定、頻繁に変更される
