import { createRouter, createRootRoute, createRoute } from "@tanstack/react-router";
import App from "./App";
import { TranscriptView } from "./routes/TranscriptView";
import { SettingsView } from "./routes/SettingsView";
import { SessionList } from "./routes/SessionList";

const rootRoute = createRootRoute({
  component: App,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TranscriptView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionList,
});

const routeTree = rootRoute.addChildren([indexRoute, settingsRoute, sessionsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
