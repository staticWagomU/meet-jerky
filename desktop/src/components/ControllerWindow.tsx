import { useState } from "react";
import { toErrorMessage } from "../utils/errorMessage";
import * as actions from "../utils/controllerActions";

interface ActionButton {
  label: string;
  run: () => Promise<void>;
}

interface ActionGroup {
  title: string;
  buttons: ActionButton[];
}

const GROUPS: ActionGroup[] = [
  {
    title: "検知通知",
    buttons: [
      {
        label: "Zoom検知",
        run: () => actions.triggerMeetingDetection("app"),
      },
      {
        label: "Meet検知",
        run: () => actions.triggerMeetingDetection("browser"),
      },
      {
        label: "通知表示",
        run: () => actions.setMeetingPromptVisible(true),
      },
      {
        label: "通知を隠す",
        run: () => actions.setMeetingPromptVisible(false),
      },
    ],
  },
  {
    title: "ライブ文字起こし",
    buttons: [
      {
        label: "文字起こしを表示",
        run: () => actions.setLiveCaptionVisible(true),
      },
      {
        label: "文字起こしを隠す",
        run: () => actions.setLiveCaptionVisible(false),
      },
      { label: "状態同期", run: () => actions.emitLiveCaptionStatus() },
      { label: "発話追加", run: () => actions.emitTranscriptionResult() },
      {
        label: "文字起こしエラー",
        run: () => actions.emitTranscriptionError(),
      },
      {
        label: "文字起こしリセット",
        run: () => actions.emitLiveCaptionReset(),
      },
    ],
  },
  {
    title: "REC表示",
    buttons: [
      {
        label: "控えめ",
        run: async () => {
          await actions.setRingLightVisible(true);
          await actions.emitRingLightMode("soft");
        },
      },
      { label: "明るい", run: () => actions.emitRingLightMode("bright") },
      { label: "消灯", run: () => actions.emitRingLightMode("off") },
      { label: "RECを隠す", run: () => actions.setRingLightVisible(false) },
    ],
  },
  {
    title: "メニューバー",
    buttons: [
      { label: "メイン表示", run: () => actions.showMainWindow() },
      {
        label: "メイン表示要求",
        run: () => actions.emitShowMainRequest(),
      },
      {
        label: "録音開始要求",
        run: () => actions.emitMeetingStartRequest(),
      },
    ],
  },
];

interface ActionStatus {
  kind: "ok" | "err";
  message: string;
}

interface Scenario {
  title: string;
  label: string;
  detail: string;
  tone: "ready" | "hot" | "safe";
  run: () => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    title: "検知通知",
    label: "通知開始",
    detail: "通知から録音・別トラック・REC・文字起こし・翻訳切替・AIノート確認",
    tone: "ready",
    run: async () => {
      await actions.triggerMeetingDetection("browser");
      await actions.setMeetingPromptVisible(true);
      await actions.emitMeetingStartRequest();
      await actions.setRingLightVisible(true);
      await actions.emitRingLightMode("soft");
      await actions.setLiveCaptionVisible(true);
      await actions.emitLiveCaptionStatus();
    },
  },
  {
    title: "メニューバー",
    label: "手動開始",
    detail: "メニュー録音・REC・文字起こし・翻訳切替・AIノート確認",
    tone: "hot",
    run: async () => {
      await actions.showMainWindow();
      await actions.emitMeetingStartRequest();
      await actions.setRingLightVisible(true);
      await actions.emitRingLightMode("soft");
      await actions.setLiveCaptionVisible(true);
      await actions.emitLiveCaptionStatus();
    },
  },
  {
    title: "録音中",
    label: "ライブノート",
    detail: "文字起こし・翻訳切替・端末内ノート・未送信の質問準備",
    tone: "safe",
    run: async () => {
      await actions.setLiveCaptionVisible(true);
      await actions.emitLiveCaptionStatus();
      await actions.emitTranscriptionResult();
      await actions.setRingLightVisible(true);
      await actions.emitRingLightMode("bright");
    },
  },
];

const CONTROLLER_RECORDING_FLOW = [
  {
    label: "検知",
    value: "通知",
    detail: "Zoom / Meet",
    tone: "accent",
  },
  {
    label: "開始",
    value: "通知/メニュー",
    detail: "手動確認",
    tone: "warn",
  },
  {
    label: "REC",
    value: "常時表示",
    detail: "控えめ/明るい",
    tone: "safe",
  },
  {
    label: "ライブ",
    value: "文字起こし",
    detail: "原文表示",
    tone: "accent",
  },
  {
    label: "翻訳",
    value: "切替可",
    detail: "必要時だけ",
    tone: "accent",
  },
  {
    label: "保存",
    value: "このMac",
    detail: "送信なし",
    tone: "safe",
  },
] as const;

export function ControllerWindow() {
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const controllerRecordingFlowLabel = [
    "録音導線の検証フロー",
    "会議検知通知またはメニューバー録音から開始",
    "開始後はRECを常時表示",
    "ライブ文字起こし、翻訳切替、AIノート確認を開きます",
    "録音履歴はこのMacに保存し、ネットワーク送信と課金操作は行いません",
  ].join("。");

  const handleClick = (label: string, run: () => Promise<void>) => {
    run()
      .then(() => setStatus({ kind: "ok", message: `完了: ${label}` }))
      .catch((e) => {
        console.error(`確認操作に失敗しました: ${label}`, toErrorMessage(e));
        setStatus({
          kind: "err",
          message: `失敗: ${label}`,
        });
      });
  };

  return (
    <div className="controller-window">
      <header className="controller-header" data-tauri-drag-region>
        <h1 className="controller-title">Meet Jerky 検証</h1>
        <p className="controller-subtitle">
          通知録音、メニューバー録音、常駐REC、文字起こし、翻訳、ノートの導線検証。
        </p>
        <div
          className="controller-transparency-strip"
          role="status"
          aria-label="録音導線の検証モードです。通知録音とメニューバー録音を確認します。REC表示、ライブ文字起こし、翻訳切替、AIノート確認、未送信の質問準備を開きます。ネットワーク送信なし。課金操作なし。"
          title="録音導線の検証モードです。通知録音とメニューバー録音を確認します。REC表示、ライブ文字起こし、翻訳切替、AIノート確認、未送信の質問準備を開きます。ネットワーク送信なし。課金操作なし。"
        >
          <span>検証モード</span>
          <span>通知 / メニューバー録音</span>
          <span>翻訳切替</span>
          <span>AI質問未送信</span>
          <span>ネットワーク送信なし</span>
          <span>課金操作なし</span>
        </div>
        <div
          className="controller-recording-flow"
          role="status"
          aria-label={controllerRecordingFlowLabel}
          title={controllerRecordingFlowLabel}
        >
          {CONTROLLER_RECORDING_FLOW.map((item) => (
            <span
              key={`${item.label}-${item.value}`}
              className={`controller-recording-flow-step controller-recording-flow-step-${item.tone}`}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </span>
          ))}
        </div>
      </header>
      <section
        className="controller-scenario-rail"
        aria-label="録音導線シナリオ。通知録音、メニューバー録音、録音中の翻訳切替とライブノートを確認します。"
        title="録音導線シナリオ。通知録音、メニューバー録音、録音中の翻訳切替とライブノートを確認します。"
      >
        <div className="controller-scenario-head">
          <span>録音導線</span>
          <strong>検証</strong>
        </div>
        <div className="controller-scenario-grid">
          {SCENARIOS.map((scenario) => (
            <button
              key={scenario.title}
              type="button"
              className={`controller-scenario-card controller-scenario-card-${scenario.tone}`}
              onClick={() => handleClick(scenario.label, scenario.run)}
              aria-label={`${scenario.title}: ${scenario.label}。${scenario.detail}`}
              title={`${scenario.title}: ${scenario.detail}`}
            >
              <span>{scenario.title}</span>
              <strong>{scenario.label}</strong>
              <small>{scenario.detail}</small>
            </button>
          ))}
        </div>
      </section>
      {GROUPS.map((group) => (
        <section
          key={group.title}
          className="controller-group"
          aria-label={group.title}
        >
          <h2 className="controller-group-title">{group.title}</h2>
          <div className="controller-buttons">
            {group.buttons.map((button) => (
              <button
                key={button.label}
                type="button"
                className="controller-button"
                onClick={() => handleClick(button.label, button.run)}
              >
                {button.label}
              </button>
            ))}
          </div>
        </section>
      ))}
      <footer
        className={`controller-status controller-status-${status?.kind ?? "idle"}`}
        role="status"
        aria-live="polite"
      >
        {status?.message ?? "操作待ち"}
      </footer>
    </div>
  );
}
