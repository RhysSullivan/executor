import {
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { ExecutorProvider } from "@executor/react";
import { ToolsPage } from "@web/pages/tools";
import { SourcesPage } from "@web/pages/sources";
import { SourcesAddPage } from "@web/pages/sources-add";
import { SourceDetailPage } from "@web/pages/source-detail";
import { SecretsPage } from "@web/pages/secrets";
import { Shell } from "@web/shell";

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
// Routes — same as apps/web
// ---------------------------------------------------------------------------

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: SourcesPage,
});

const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  component: ToolsPage,
});

const sourcesAddRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources/add/$pluginKey",
  validateSearch: (
    search: Record<string, unknown>,
  ): { url?: string; preset?: string } => ({
    url: typeof search.url === "string" ? search.url : undefined,
    preset: typeof search.preset === "string" ? search.preset : undefined,
  }),
  component: () => {
    const { pluginKey } = sourcesAddRoute.useParams();
    const { url, preset } = sourcesAddRoute.useSearch();
    return (
      <SourcesAddPage pluginKey={pluginKey} url={url} preset={preset} />
    );
  },
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
  sourcesAddRoute,
  sourceDetailRoute,
  secretsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
