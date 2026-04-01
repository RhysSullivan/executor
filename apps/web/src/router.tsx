import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { ExecutorProvider } from "@executor/react";
import { ToolsPage } from "./pages/tools";
import { SourcesPage } from "./pages/sources";
import { SecretsPage } from "./pages/secrets";
import { Shell } from "./shell";

// ---------------------------------------------------------------------------
// Root layout
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: () => (
    <ExecutorProvider>
      <Shell>
        <Outlet />
      </Shell>
    </ExecutorProvider>
  ),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ToolsPage,
});

const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  component: ToolsPage,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: SourcesPage,
});

const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/secrets",
  component: SecretsPage,
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routeTree = rootRoute.addChildren([
  indexRoute,
  toolsRoute,
  sourcesRoute,
  secretsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
