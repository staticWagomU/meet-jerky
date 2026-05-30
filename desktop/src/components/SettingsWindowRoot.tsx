import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../lib/queryClient";
import { SettingsView } from "../routes/SettingsView";
import {
  isSettingsCategoryKey,
  SETTINGS_WINDOW_REQUEST_EVENT,
  type SettingsCategoryKey,
} from "../utils/settingsWindow";
import { isTauriRuntime } from "../utils/browserRuntime";

function readInitialSettingsCategory(): SettingsCategoryKey {
  const category = new URLSearchParams(window.location.search).get("category");
  return isSettingsCategoryKey(category) ? category : "general";
}

const settingsWindowBoundaryFlow = [
  { label: "録音", value: "別トラック" },
  { label: "文字起こし", value: "ライブ / 履歴" },
  { label: "AI議事録", value: "手動確認" },
  { label: "保存", value: "このMac" },
] as const;

const settingsWindowBoundaryFlowLabel = settingsWindowBoundaryFlow
  .map((step) => `${step.label}: ${step.value}`)
  .join("、");

export function SettingsWindowRoot() {
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryKey>(
    readInitialSettingsCategory,
  );

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let disposed = false;
    const unlistenPromise = listen<string>(SETTINGS_WINDOW_REQUEST_EVENT, (event) => {
      if (disposed) {
        return;
      }
      setActiveCategory(
        isSettingsCategoryKey(event.payload) ? event.payload : "general",
      );
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => {
        unlisten();
      });
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="settings-window-shell">
        <header
          className="settings-window-standalone-header"
          data-tauri-drag-region
        >
          <div className="settings-window-standalone-copy">
            <span className="settings-window-standalone-kicker">Settings</span>
            <h1>Meet Jerky 設定</h1>
            <p>録音、文字起こし、AI議事録、保存範囲をここで整えます。</p>
          </div>
          <div
            className="settings-window-standalone-flow"
            role="status"
            aria-label={settingsWindowBoundaryFlowLabel}
            title={settingsWindowBoundaryFlowLabel}
          >
            {settingsWindowBoundaryFlow.map((step) => (
              <span
                className="settings-window-standalone-flow-step"
                key={step.label}
              >
                <span>{step.label}</span>
                <strong>{step.value}</strong>
              </span>
            ))}
          </div>
        </header>
        <SettingsView
          initialCategory={activeCategory}
          windowVariant="standalone"
        />
      </div>
    </QueryClientProvider>
  );
}
