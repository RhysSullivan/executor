import React from "react";
import { createRootRoute } from "@tanstack/react-router";
import { ExecutorProvider } from "@executor/react/api/provider";
import { RoutesProvider, type AppRoutes } from "@executor/react/api/routes-context";
import { Shell } from "../web/shell";

export const Route = createRootRoute({
  component: RootComponent,
});

// Local app still lives at the root — no workspace slug yet. When we add
// multi-workspace support this is where the workspace param gets threaded
// through the AppRoutes builder.
const localRoutes: AppRoutes = {
  home: { to: "/" },
  sourceDetail: (sourceId) => ({
    to: "/sources/$namespace",
    params: { namespace: sourceId },
  }),
  sourcesAdd: (pluginKey, search) => ({
    to: "/sources/add/$pluginKey",
    params: { pluginKey },
    search,
  }),
};

function RootComponent() {
  return (
    <ExecutorProvider>
      <RoutesProvider value={localRoutes}>
        <Shell />
      </RoutesProvider>
    </ExecutorProvider>
  );
}
