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
        <SettingsView
          initialCategory={activeCategory}
          windowVariant="standalone"
        />
      </div>
    </QueryClientProvider>
  );
}
