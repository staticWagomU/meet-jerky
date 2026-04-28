import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isRingLightModePayload,
  RING_LIGHT_MODE_EVENT,
  type RingLightMode,
} from "../utils/ringLight";

export function RingLightWindow() {
  const [mode, setMode] = useState<RingLightMode>("soft");

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<unknown>(RING_LIGHT_MODE_EVENT, (event) => {
      if (disposed || !isRingLightModePayload(event.payload)) {
        return;
      }
      setMode(event.payload.mode === "off" ? "soft" : event.payload.mode);
    });

    return () => {
      disposed = true;
      unlistenPromise
        .then((unlisten) => unlisten())
        .catch((e) => {
          console.error("リングライト設定の受信解除に失敗しました:", e);
        });
    };
  }, []);

  return (
    <div
      className={`ring-light-window ring-light-window-${mode}`}
      aria-hidden="true"
      data-tauri-drag-region
    >
      <div className="ring-light-edge ring-light-edge-top" />
      <div className="ring-light-edge ring-light-edge-right" />
      <div className="ring-light-edge ring-light-edge-bottom" />
      <div className="ring-light-edge ring-light-edge-left" />
    </div>
  );
}
