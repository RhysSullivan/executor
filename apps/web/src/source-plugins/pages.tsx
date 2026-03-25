import { Link } from "@tanstack/react-router";
import { useSource } from "@executor/react";
import {
  ExecutorPluginRouteProvider,
  LoadableBlock,
  SourcePluginRouteProvider,
  createSourcePluginPaths,
  type ExecutorPluginNavigation,
  type FrontendPluginRouteDefinition,
  type FrontendPluginRouteParams,
  type FrontendPluginRouteSearch,
  type FrontendSourceDetailRouteDefinition,
  type SourcePluginNavigation,
  type SourcePluginRouteParams,
  type SourcePluginRouteSearch,
} from "@executor/react/plugins";

import { SourcePluginsResetState } from "../components/source-plugins-reset-state";
import {
  getFrontendPlugin,
  getFrontendPluginRoute,
  getSourceFrontendTypeEntry,
  getSourceFrontendTypeEntryByKey,
  registeredSourceFrontendTypes,
} from "./index";

const FrontendPluginUnavailableState = () => (
  <SourcePluginsResetState
    title="Frontend plugins are unavailable"
    message="No frontend plugins are registered in this build."
  />
);

const SourcePluginUnavailableState = () => (
  <SourcePluginsResetState
    title="Source plugins are unavailable"
    message="No source plugins are registered in this build."
  />
);

const SourcePluginPicker = (props: {
  activeKey: string | null;
}) => {
  if (registeredSourceFrontendTypes.length === 0) {
    return null;
  }

  return (
    <div className="mb-8 flex flex-wrap gap-2">
      {registeredSourceFrontendTypes.map((definition) => (
        <Link
          key={definition.key}
          to={createSourcePluginPaths(definition.key).add}
          className={
            props.activeKey === definition.key
              ? "rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-foreground"
              : "rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {definition.displayName}
        </Link>
      ))}
    </div>
  );
};

const SourcePluginRouteMismatchState = (props: {
  requestedDisplayName: string;
  actualDisplayName: string;
}) => (
  <SourcePluginsResetState
    title="Source route mismatch"
    message={`This source belongs to ${props.actualDisplayName}, but the current route is mounted for ${props.requestedDisplayName}. Reopen it from the source list to use the canonical plugin route.`}
  />
);

export function ExecutorPluginRoutePage(input: {
  pluginKey: string;
  routeKey: FrontendPluginRouteDefinition["key"];
  params: FrontendPluginRouteParams;
  search: FrontendPluginRouteSearch;
  navigation: ExecutorPluginNavigation;
}) {
  const plugin = getFrontendPlugin(input.pluginKey);
  if (plugin === null) {
    return <FrontendPluginUnavailableState />;
  }

  const routeEntry = getFrontendPluginRoute(input.pluginKey, input.routeKey);
  if (routeEntry === null) {
    return (
      <SourcePluginsResetState
        title="Plugin route is unavailable"
        message={`No plugin route is registered for "${input.routeKey}" in "${input.pluginKey}".`}
      />
    );
  }

  const PluginPage = routeEntry.route.component;

  return (
    <ExecutorPluginRouteProvider
      value={{
        plugin,
        route: routeEntry.route,
        params: input.params,
        search: input.search,
        navigation: input.navigation,
      }}
    >
      <div className="h-full min-h-0">
        <PluginPage />
      </div>
    </ExecutorPluginRouteProvider>
  );
}

export function SourcePluginsIndexPage() {
  if (registeredSourceFrontendTypes.length === 0) {
    return <SourcePluginUnavailableState />;
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="rounded-3xl border border-border bg-card p-8">
        <div className="inline-flex rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Source Plugins
        </div>
        <h1 className="mt-5 font-display text-3xl tracking-tight text-foreground lg:text-4xl">
          Choose a source plugin
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          Each plugin owns its own connection flow, detail routes, and UI.
          Pick the plugin that should own this source.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {registeredSourceFrontendTypes.map((definition) => {
          const paths = createSourcePluginPaths(definition.key);

          return (
            <Link
              key={definition.key}
              to={paths.add}
              className="group rounded-3xl border border-border bg-card p-6 transition-colors hover:border-primary/30 hover:bg-card/90"
            >
              <div className="flex h-full flex-col">
                <div className="text-lg font-semibold text-foreground">
                  {definition.displayName}
                </div>
                <div className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                  {definition.description
                    ?? "Open the plugin-owned source flow."}
                </div>
                <div className="mt-6 text-xs font-medium uppercase tracking-[0.2em] text-primary">
                  Open Plugin
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function SourcePluginAddPage(props: {
  definitionKey: string;
  navigation: SourcePluginNavigation;
}) {
  const entry = getSourceFrontendTypeEntryByKey(props.definitionKey);
  if (entry === null) {
    return <SourcePluginUnavailableState />;
  }

  const AddPage = entry.definition.renderAddPage;

  return (
    <SourcePluginRouteProvider
      value={{
        plugin: entry.plugin,
        definition: entry.definition,
        params: {},
        search: {},
        navigation: props.navigation,
      }}
    >
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <div className="inline-flex rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Source Plugin
          </div>
          <h1 className="mt-5 font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            {entry.definition.displayName}
          </h1>
          {entry.definition.description && (
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {entry.definition.description}
            </p>
          )}
        </div>

        <SourcePluginPicker activeKey={entry.definition.key} />
        <AddPage />
      </div>
    </SourcePluginRouteProvider>
  );
}

export function SourcePluginEditPage(input: {
  definitionKey: string;
  sourceId: string;
  params?: SourcePluginRouteParams;
  search?: SourcePluginRouteSearch;
  navigation: SourcePluginNavigation;
}) {
  const requestedEntry = getSourceFrontendTypeEntryByKey(input.definitionKey);
  const source = useSource(input.sourceId);

  if (requestedEntry === null) {
    return <SourcePluginUnavailableState />;
  }

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => {
        const entry = getSourceFrontendTypeEntry(loadedSource.kind);
        if (entry === null) {
          return (
            <SourcePluginsResetState
              title="Source plugin is unavailable"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        if (entry.definition.key !== requestedEntry.definition.key) {
          return (
            <SourcePluginRouteMismatchState
              requestedDisplayName={requestedEntry.definition.displayName}
              actualDisplayName={entry.definition.displayName}
            />
          );
        }

        if (entry.definition.renderEditPage === undefined) {
          return (
            <SourcePluginsResetState
              title="Source editing is disabled"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        const EditPage = entry.definition.renderEditPage;

        return (
          <SourcePluginRouteProvider
            value={{
              plugin: entry.plugin,
              definition: entry.definition,
              params: input.params ?? {
                sourceId: input.sourceId,
              },
              search: input.search ?? {},
              navigation: input.navigation,
            }}
          >
            <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
              <EditPage source={loadedSource} />
            </div>
          </SourcePluginRouteProvider>
        );
      }}
    </LoadableBlock>
  );
}

export function SourcePluginDetailPage(input: {
  definitionKey: string;
  sourceId: string;
  params?: SourcePluginRouteParams;
  search: SourcePluginRouteSearch;
  navigation: SourcePluginNavigation;
}) {
  const requestedEntry = getSourceFrontendTypeEntryByKey(input.definitionKey);
  const source = useSource(input.sourceId);

  if (requestedEntry === null) {
    return <SourcePluginUnavailableState />;
  }

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => {
        const entry = getSourceFrontendTypeEntry(loadedSource.kind);
        if (entry === null) {
          return (
            <SourcePluginsResetState
              title="Source plugin is unavailable"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        if (entry.definition.key !== requestedEntry.definition.key) {
          return (
            <SourcePluginRouteMismatchState
              requestedDisplayName={requestedEntry.definition.displayName}
              actualDisplayName={entry.definition.displayName}
            />
          );
        }

        if (entry.definition.renderDetailPage === undefined) {
          return (
            <SourcePluginsResetState
              title="Source detail is disabled"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        const DetailPage = entry.definition.renderDetailPage;

        return (
          <SourcePluginRouteProvider
            value={{
              plugin: entry.plugin,
              definition: entry.definition,
              params: input.params ?? {
                sourceId: input.sourceId,
              },
              search: input.search,
              navigation: input.navigation,
            }}
          >
            <div className="h-full min-h-0">
              <DetailPage source={loadedSource} />
            </div>
          </SourcePluginRouteProvider>
        );
      }}
    </LoadableBlock>
  );
}

export function SourcePluginDetailChildPage(input: {
  definitionKey: string;
  routeKey: FrontendSourceDetailRouteDefinition["key"];
  sourceId: string;
  params: SourcePluginRouteParams;
  search: SourcePluginRouteSearch;
  navigation: SourcePluginNavigation;
}) {
  const requestedEntry = getSourceFrontendTypeEntryByKey(input.definitionKey);
  const source = useSource(input.sourceId);

  if (requestedEntry === null) {
    return <SourcePluginUnavailableState />;
  }

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => {
        const entry = getSourceFrontendTypeEntry(loadedSource.kind);
        if (entry === null) {
          return (
            <SourcePluginsResetState
              title="Source plugin is unavailable"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        if (entry.definition.key !== requestedEntry.definition.key) {
          return (
            <SourcePluginRouteMismatchState
              requestedDisplayName={requestedEntry.definition.displayName}
              actualDisplayName={entry.definition.displayName}
            />
          );
        }

        const detailRoute = entry.definition.detailRoutes?.find((route) =>
          route.key === input.routeKey
        );

        if (!detailRoute) {
          return (
            <SourcePluginsResetState
              title="Source route is unavailable"
              message={`No plugin-owned detail route is registered for "${input.routeKey}".`}
            />
          );
        }

        const DetailRoutePage = detailRoute.component;

        return (
          <SourcePluginRouteProvider
            value={{
              plugin: entry.plugin,
              definition: entry.definition,
              params: input.params,
              search: input.search,
              navigation: input.navigation,
            }}
          >
            <div className="h-full min-h-0">
              <DetailRoutePage source={loadedSource} />
            </div>
          </SourcePluginRouteProvider>
        );
      }}
    </LoadableBlock>
  );
}
