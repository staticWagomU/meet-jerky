import type { SessionContent } from "../hooks/useSessionContent";
import type { SessionSummary } from "../hooks/useSessionList";

export const PREVIEW_SESSION_PATH =
  "/Users/wagomu/MeetJerky/2026-05-29-product-review.md";

const previewSessionBody = `# プロダクトレビュー / Meet Jerky v2 - 2026-05-29 10:30
**[00:00:08] 自分:** 今日のゴールは、録音中の透明性と録音後の議事録導線を v2 UI に合わせて確認することです。
**[00:00:24] 相手側:** 検知通知から録音を始められることと、メニューバーから手動録音できることは残したいです。
**[00:01:02] 自分:** 録音中は REC インジケーター、リアルタイム文字起こし、翻訳切り替え、会議ノートと質問準備のオンオフを同じ面で扱います。
**[00:01:39] 相手側:** 議事録生成を使う前に、送信される範囲と送られない音声トラックが見えると安心です。
**[00:02:18] 自分:** 録音後は LINE 風の発話タイムラインで、自分と相手側の分離トラックを確認できるようにします。
**[00:03:04] 相手側:** 議事録テンプレートは週次定例、1on1、採用面接、顧客定例くらいから選べると十分です。
**[00:03:42] 自分:** 手書きメモや補足メモは、議事録生成時の追加コンテキストとして明示的に足せる設計にします。
**[00:04:15] 相手側:** 設定ではマイク、検出ルール、文字起こしエンジン、AIプロバイダーを一箇所で見直したいです。

## 補足メモ
- v2 の紙色、墨色、アンバー、ブルーを維持。
- AIプロバイダーはオフを初期状態にして、送信前の確認を明示。
- 音声トラック再生は保存済みトラックがある場合に、履歴詳細で自分/相手側/両方を切り替える。`;

export const previewSessionContent: SessionContent = {
  path: PREVIEW_SESSION_PATH,
  body: previewSessionBody,
};

export const previewSessionSummaries: SessionSummary[] = [
  {
    path: PREVIEW_SESSION_PATH,
    startedAtSecs: 1780018200,
    title: "プロダクトレビュー / Meet Jerky v2 - 2026-05-29 10:30",
    searchText: previewSessionBody,
  },
  {
    path: "/Users/wagomu/MeetJerky/2026-05-28-weekly-sync.md",
    startedAtSecs: 1779933600,
    title: "週次定例 - 2026-05-28 11:00",
    searchText: `# 週次定例 - 2026-05-28 11:00
**[00:00:11] 自分:** 先週の検知ルール改善で Google Meet の取りこぼしが減りました。
**[00:00:45] 相手側:** 次は Teams と Zoom のウィンドウタイトルも同じ精度で見たいです。
**[00:01:22] 自分:** タスクは検出ログ、録音状態、文字起こし遅延の三つを分けて追います。`,
  },
  {
    path: "/Users/wagomu/MeetJerky/2026-05-27-customer-demo.md",
    startedAtSecs: 1779854400,
    title: "顧客デモ - 2026-05-27 13:00",
    searchText: `# 顧客デモ - 2026-05-27 13:00
**[00:00:09] 相手側:** 顧客定例では決定事項と次回までの宿題が一目で分かると助かります。
**[00:00:58] 自分:** 議事録テンプレートで決定事項、リスク、タスクを分けて生成できるようにします。
**[00:02:10] 相手側:** 録音中であることが常に分かる UI は必須です。`,
  },
];

export function getPreviewSessionContent(path: string): SessionContent | null {
  if (path === previewSessionContent.path) {
    return previewSessionContent;
  }
  const summary = previewSessionSummaries.find(
    (session) => session.path === path,
  );
  return summary ? { path: summary.path, body: summary.searchText } : null;
}
