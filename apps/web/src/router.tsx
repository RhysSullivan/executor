import {
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { ExecutorProvider } from "@executor/react";
import { ToolsPage } from "./pages/tools";
import { SourcesPage } from "./pages/sources";
import { SourceDetailPage } from "./pages/source-detail";
import { SecretsPage } from "./pages/secrets";
import { Shell } from "./shell";

// ---------------------------------------------------------------------------
// Root layout — Shell renders <Outlet /> directly
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: () => (
    <ExecutorProvider>
      <Shell />
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

const sourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources/$namespace",
  component: () => {
    const { namespace } = sourceDetailRoute.useParams();
    return <SourceDetailPage namespace={namespace} />;
  },
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
  sourceDetailRoute,
  secretsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
