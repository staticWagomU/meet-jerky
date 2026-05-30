import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { router } from "./router";
import { queryClient } from "./lib/queryClient";
import { MeetingDetectedBanner } from "./components/MeetingDetectedBanner";
import { LiveCaptionWindow } from "./components/LiveCaptionWindow";
import { RingLightWindow } from "./components/RingLightWindow";
import { ControllerWindow } from "./components/ControllerWindow";
import { SettingsWindowRoot } from "./components/SettingsWindowRoot";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/funnel-sans/latin-400.css";
import "@fontsource/funnel-sans/latin-500.css";
import "@fontsource/funnel-sans/latin-600.css";
import "@fontsource/funnel-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./App.css";

function readCurrentWindowLabel(): { isTauriRuntime: boolean; label: string } {
  try {
    return { isTauriRuntime: true, label: getCurrentWindow().label };
  } catch {
    return { isTauriRuntime: false, label: "main" };
  }
}

const currentWindow = readCurrentWindowLabel();
const urlWindowLabel = new URLSearchParams(window.location.search).get("window");
const windowLabel = currentWindow.isTauriRuntime
  ? currentWindow.label
  : urlWindowLabel ?? currentWindow.label;
document.documentElement.dataset.window = windowLabel;
document.body.dataset.window = windowLabel;

const root =
  windowLabel === "meeting-prompt" ? (
    <div className="overlay-window meeting-prompt-window">
      <MeetingDetectedBanner />
    </div>
  ) : windowLabel === "live-caption" ? (
    <LiveCaptionWindow />
  ) : windowLabel === "ring-light" ? (
    <RingLightWindow />
  ) : windowLabel === "controller" ? (
    <ControllerWindow />
  ) : windowLabel === "settings" ? (
    <SettingsWindowRoot />
  ) : (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
