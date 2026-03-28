import type {
  Source,
} from "@executor/react";
import {
  ExecutionHistoryReactPlugin,
} from "@executor/plugin-execution-history-react";
import {
  GoogleDiscoveryReactPlugin,
  getGoogleDiscoveryIconUrl,
} from "@executor/plugin-google-discovery-react";
import {
  GraphqlReactPlugin,
} from "@executor/plugin-graphql-react";
import {
  McpReactPlugin,
} from "@executor/plugin-mcp-react";
import {
  OpenApiReactPlugin,
} from "@executor/plugin-openapi-react";
import {
  createExecutorPluginPaths,
  createSourcePluginPaths,
  registerExecutorFrontendPlugins,
  type ExecutorFrontendPlugin,
} from "@executor/react/plugins";

const frontendPlugins = [
  ExecutionHistoryReactPlugin,
  McpReactPlugin,
  GraphqlReactPlugin,
  GoogleDiscoveryReactPlugin,
  OpenApiReactPlugin,
] as const satisfies readonly ExecutorFrontendPlugin[];

const frontendPluginRegistry = registerExecutorFrontendPlugins(frontendPlugins);

const hasRouteKey = (
  plugin: ExecutorFrontendPlugin,
  routeKey: string,
): boolean =>
  (plugin.routes ?? []).some((route) => route.key === routeKey);

const isSourceFrontendPlugin = (
  plugin: ExecutorFrontendPlugin,
): boolean =>
  hasRouteKey(plugin, "add")
  && hasRouteKey(plugin, "detail");

export const registeredFrontendPlugins = frontendPluginRegistry.plugins;
export const registeredFrontendPluginRoutes = frontendPluginRegistry.routes;
export const registeredFrontendPluginNavRoutes =
  registeredFrontendPluginRoutes
    .filter(({ route }) => route.nav !== undefined)
    .map(({ plugin, route }) => ({
      plugin,
      route,
      to: createExecutorPluginPaths(plugin.key).route(route.path ?? ""),
    }));
export const registeredSourceFrontendPlugins =
  registeredFrontendPlugins.filter(isSourceFrontendPlugin);

export const getFrontendPlugin = (key: string) =>
  frontendPluginRegistry.getPlugin(key);

export const getFrontendPluginRoute = (
  pluginKey: string,
  routeKey: string,
) => frontendPluginRegistry.getRoute(pluginKey, routeKey);

export const getSourceFrontendPlugin = (kind: string) => {
  const plugin = getFrontendPlugin(kind);
  return plugin && isSourceFrontendPlugin(plugin) ? plugin : null;
};

export const getSourceFrontendPaths = (kind: string) => {
  const plugin = getSourceFrontendPlugin(kind);
  return plugin ? createSourcePluginPaths(plugin.key) : null;
};

export const getSourceFrontendIconUrl = (source: Source) =>
  source.kind === "google-discovery"
    ? getGoogleDiscoveryIconUrl(source)
    : null;
