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
import "./App.css";

const currentWindowLabel = getCurrentWindow().label;
document.documentElement.dataset.window = currentWindowLabel;
document.body.dataset.window = currentWindowLabel;

const root =
  currentWindowLabel === "meeting-prompt" ? (
    <div className="overlay-window meeting-prompt-window">
      <MeetingDetectedBanner />
    </div>
  ) : currentWindowLabel === "live-caption" ? (
    <LiveCaptionWindow />
  ) : currentWindowLabel === "ring-light" ? (
    <RingLightWindow />
  ) : (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
