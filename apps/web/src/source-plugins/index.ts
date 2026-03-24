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
} from "@executor/react/source-plugins";

const frontendPlugins = [
  McpReactPlugin,
  GraphqlReactPlugin,
  GoogleDiscoveryReactPlugin,
  OpenApiReactPlugin,
] as const satisfies readonly ExecutorFrontendPlugin[];

const frontendSourceRegistry = registerExecutorFrontendPlugins(frontendPlugins);

export const registeredSourceFrontendTypes = frontendSourceRegistry.sourceTypes;

export const getSourceFrontendType = (kind: string) =>
  frontendSourceRegistry.getSourceType(kind);

export const getSourceFrontendTypeByKey = (key: string) =>
  frontendSourceRegistry.getSourceTypeByKey(key);

export const getDefaultSourceFrontendType = () =>
  frontendSourceRegistry.getDefaultSourceType();

export const getSourceFrontendPaths = (kind: string) => {
  const definition = getSourceFrontendType(kind);
  return definition ? createSourcePluginPaths(definition.key) : null;
};
