import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from "@tanstack/react-router";
import { ExecutorReactProvider } from "@executor/react";
import {
  createExecutorPluginPaths,
  sourcePluginsIndexPath,
  type ExecutorPluginNavigation,
  type FrontendPluginRouteSearch,
} from "@executor/react/plugins";

import "./globals.css";

import { AppShell } from "./components/shell";
import {
  registeredFrontendPluginRoutes,
} from "./plugins";
import {
  ExecutorPluginRoutePage,
  SourcePluginsIndexPage,
} from "./plugins/pages";
import { HomePage } from "./views/home";
import { SecretsPage } from "./views/secrets";

const rootRoute = createRootRoute({
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const sourcePluginsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: sourcePluginsIndexPath,
  component: SourcePluginsIndexPage,
});

const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/secrets",
  component: SecretsPage,
});

const createExecutorPluginNavigation = (
  pluginKey: string,
  input: {
    navigateTo: (
      to: string,
      search?: FrontendPluginRouteSearch,
    ) => void | Promise<void>;
    updateSearch?: (
      search: FrontendPluginRouteSearch,
    ) => void | Promise<void>;
  },
): ExecutorPluginNavigation => {
  const paths = createExecutorPluginPaths(pluginKey);

  return {
    paths,
    home: () => input.navigateTo("/"),
    route: (path = "", search) => input.navigateTo(paths.route(path), search),
    updateSearch: (search) => input.updateSearch?.(search),
  };
};

const frontendPluginRoutes = registeredFrontendPluginRoutes.map(({ plugin, route }) => {
  const paths = createExecutorPluginPaths(plugin.key);

  const PluginRouteComponent = () => {
    const params = pluginRoute.useParams() as Record<string, string | undefined>;
    const search = pluginRoute.useSearch();
    const navigate = useNavigate();
    const navigateFromRoute = useNavigate({ from: pluginRoute.fullPath });
    const navigation = createExecutorPluginNavigation(plugin.key, {
      navigateTo: (to, nextSearch) =>
        nextSearch === undefined ? navigate({ to }) : navigate({ to, search: nextSearch }),
      updateSearch: (nextSearch) => navigateFromRoute({ search: nextSearch }),
    });

    return (
      <ExecutorPluginRoutePage
        pluginKey={plugin.key}
        routeKey={route.key}
        params={params}
        search={search}
        navigation={navigation}
      />
    );
  };

  const pluginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: paths.routePattern(route.path ?? ""),
    component: PluginRouteComponent,
  });

  return pluginRoute;
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  secretsRoute,
  sourcePluginsIndexRoute,
  ...frontendPluginRoutes,
]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export const App = () => (
  <ExecutorReactProvider>
    <RouterProvider router={router} />
  </ExecutorReactProvider>
);
