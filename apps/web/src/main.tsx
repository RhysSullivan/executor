import * as React from "react";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from "@tanstack/react-router";
import { ExecutorReactProvider } from "@executor/react";
import {
  createSourcePluginPaths,
  normalizeSourcePluginPath,
  sourcePluginsIndexPath,
  type FrontendSourceTypeDefinition,
  type SourcePluginNavigation,
  type SourcePluginRouteSearch,
} from "@executor/react/source-plugins";

import "./globals.css";

import { AppShell } from "./components/shell";
import {
  registeredSourceFrontendTypes,
} from "./source-plugins";
import {
  SourcePluginAddPage,
  SourcePluginDetailChildPage,
  SourcePluginDetailPage,
  SourcePluginEditPage,
  SourcePluginsIndexPage,
} from "./source-plugins/pages";
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

const createPluginNavigation = (
  definition: FrontendSourceTypeDefinition,
  input: {
    navigateTo: (
      to: string,
      search?: SourcePluginRouteSearch,
    ) => void | Promise<void>;
    updateSearch?: (
      search: SourcePluginRouteSearch,
    ) => void | Promise<void>;
  },
): SourcePluginNavigation => {
  const paths = createSourcePluginPaths(definition.key);

  return {
    paths,
    home: () => input.navigateTo("/"),
    add: () => input.navigateTo(paths.add),
    detail: (sourceId, search) => input.navigateTo(paths.detail(sourceId), search),
    edit: (sourceId, search) => input.navigateTo(paths.edit(sourceId), search),
    child: ({ sourceId, path, search }) =>
      input.navigateTo(paths.child(sourceId, path), search),
    updateSearch: (search) => input.updateSearch?.(search),
  };
};

const sourcePluginRoutes = registeredSourceFrontendTypes.flatMap((definition) => {
  const paths = createSourcePluginPaths(definition.key);

  const AddRouteComponent = () => {
    const navigate = useNavigate();
    const navigation = createPluginNavigation(definition, {
      navigateTo: (to, search) =>
        search === undefined ? navigate({ to }) : navigate({ to, search }),
    });

    return (
      <SourcePluginAddPage
        definitionKey={definition.key}
        navigation={navigation}
      />
    );
  };

  const addRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: paths.add,
    component: AddRouteComponent,
  });

  const EditRouteComponent = () => {
    const { sourceId } = editRoute.useParams() as {
      sourceId: string;
    };
    const navigate = useNavigate();
    const navigation = createPluginNavigation(definition, {
      navigateTo: (to, search) =>
        search === undefined ? navigate({ to }) : navigate({ to, search }),
    });

    return (
      <SourcePluginEditPage
        definitionKey={definition.key}
        sourceId={sourceId}
        params={{ sourceId }}
        navigation={navigation}
      />
    );
  };

  const editRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: paths.editPattern,
    component: EditRouteComponent,
  });

  const DetailRouteComponent = () => {
    const { sourceId } = detailRoute.useParams() as {
      sourceId: string;
    };
    const search = detailRoute.useSearch();
    const navigate = useNavigate();
    const navigateFromRoute = useNavigate({ from: detailRoute.fullPath });
    const navigation = createPluginNavigation(definition, {
      navigateTo: (to, nextSearch) =>
        nextSearch === undefined ? navigate({ to }) : navigate({ to, search: nextSearch }),
      updateSearch: (nextSearch) => navigateFromRoute({ search: nextSearch }),
    });

    return (
      <SourcePluginDetailPage
        definitionKey={definition.key}
        sourceId={sourceId}
        params={{ sourceId }}
        search={search}
        navigation={navigation}
      />
    );
  };

  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: paths.detailPattern,
    component: DetailRouteComponent,
  });

  const detailChildRoutes = (definition.detailRoutes ?? []).map((detailRouteDefinition) => {
    const ChildRouteComponent = () => {
      const params = childRoute.useParams() as Record<string, string | undefined> & {
        sourceId: string;
      };
      const search = childRoute.useSearch();
      const navigate = useNavigate();
      const navigateFromRoute = useNavigate({ from: childRoute.fullPath });
      const navigation = createPluginNavigation(definition, {
        navigateTo: (to, nextSearch) =>
          nextSearch === undefined ? navigate({ to }) : navigate({ to, search: nextSearch }),
        updateSearch: (nextSearch) => navigateFromRoute({ search: nextSearch }),
      });

      return (
        <SourcePluginDetailChildPage
          definitionKey={definition.key}
          routeKey={detailRouteDefinition.key}
          sourceId={params.sourceId}
          params={params}
          search={search}
          navigation={navigation}
        />
      );
    };

    const childRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: paths.childPattern(
        normalizeSourcePluginPath(detailRouteDefinition.path),
      ),
      component: ChildRouteComponent,
    });

    return childRoute;
  });

  return [
    addRoute,
    editRoute,
    ...detailChildRoutes,
    detailRoute,
  ];
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  sourcePluginsIndexRoute,
  ...sourcePluginRoutes,
  secretsRoute,
]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <React.StrictMode>
      <ExecutorReactProvider>
        <RouterProvider router={router} />
      </ExecutorReactProvider>
    </React.StrictMode>
  );
}
