import {
  GoogleDiscoveryReactPlugin,
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
  createSourcePluginPaths,
  registerExecutorFrontendPlugins,
  type ExecutorFrontendPlugin,
} from "@executor/react/plugins";

const frontendPlugins = [
  McpReactPlugin,
  GraphqlReactPlugin,
  GoogleDiscoveryReactPlugin,
  OpenApiReactPlugin,
] as const satisfies readonly ExecutorFrontendPlugin[];

const frontendPluginRegistry = registerExecutorFrontendPlugins(frontendPlugins);

export const registeredFrontendPlugins = frontendPluginRegistry.plugins;
export const registeredFrontendPluginRoutes = frontendPluginRegistry.routes;
export const registeredSourceFrontendTypeEntries =
  frontendPluginRegistry.sourceTypes;
export const registeredSourceFrontendTypes =
  registeredSourceFrontendTypeEntries.map((entry) => entry.definition);

export const getFrontendPlugin = (key: string) =>
  frontendPluginRegistry.getPlugin(key);

export const getFrontendPluginRoute = (
  pluginKey: string,
  routeKey: string,
) => frontendPluginRegistry.getRoute(pluginKey, routeKey);

export const getSourceFrontendTypeEntry = (kind: string) =>
  frontendPluginRegistry.getSourceType(kind);

export const getSourceFrontendTypeEntryByKey = (key: string) =>
  frontendPluginRegistry.getSourceTypeByKey(key);

export const getSourceFrontendType = (kind: string) =>
  getSourceFrontendTypeEntry(kind)?.definition ?? null;

export const getSourceFrontendTypeByKey = (key: string) =>
  getSourceFrontendTypeEntryByKey(key)?.definition ?? null;

export const getDefaultSourceFrontendType = () =>
  frontendPluginRegistry.getDefaultSourceType()?.definition ?? null;

export const getSourceFrontendPaths = (kind: string) => {
  const definition = getSourceFrontendType(kind);
  return definition ? createSourcePluginPaths(definition.key) : null;
};
