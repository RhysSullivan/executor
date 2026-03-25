import type {
  ExecutorFrontendPlugin,
  FrontendPluginRouteDefinition,
  FrontendSourceTypeDefinition,
} from "./types";
import {
  normalizeExecutorPluginPath,
  normalizeSourcePluginPath,
} from "./paths";

export type RegisteredFrontendPluginRoute = {
  plugin: ExecutorFrontendPlugin;
  route: FrontendPluginRouteDefinition;
};

export type RegisteredFrontendSourceType = {
  plugin: ExecutorFrontendPlugin;
  definition: FrontendSourceTypeDefinition;
};

export const defineFrontendSourceType = <
  TDefinition extends FrontendSourceTypeDefinition,
>(
  definition: TDefinition,
): TDefinition => definition;

export const defineFrontendPluginRoute = <
  TDefinition extends FrontendPluginRouteDefinition,
>(
  definition: TDefinition,
): TDefinition => definition;

export const defineExecutorFrontendPlugin = <
  TPlugin extends ExecutorFrontendPlugin,
>(
  input: TPlugin,
): TPlugin => input;

export const registerExecutorFrontendPlugins = (
  plugins: readonly ExecutorFrontendPlugin[],
) => {
  const pluginsByKey = new Map<string, ExecutorFrontendPlugin>();
  const routesByPluginAndKey = new Map<string, RegisteredFrontendPluginRoute>();
  const sourceTypesByKind = new Map<string, RegisteredFrontendSourceType>();
  const sourceTypesByKey = new Map<string, RegisteredFrontendSourceType>();

  for (const plugin of plugins) {
    if (pluginsByKey.has(plugin.key)) {
      throw new Error(`Duplicate frontend plugin registration: ${plugin.key}`);
    }

    pluginsByKey.set(plugin.key, plugin);

    const pluginRouteKeys = new Set<string>();
    const pluginRoutePaths = new Set<string>();

    for (const route of plugin.routes ?? []) {
      if (pluginRouteKeys.has(route.key)) {
        throw new Error(
          `Duplicate frontend plugin route key for ${plugin.key}: ${route.key}`,
        );
      }

      pluginRouteKeys.add(route.key);

      const normalizedPath = normalizeExecutorPluginPath(route.path ?? "");
      if (pluginRoutePaths.has(normalizedPath)) {
        throw new Error(
          `Duplicate frontend plugin route path for ${plugin.key}: ${normalizedPath || "<root>"}`,
        );
      }

      pluginRoutePaths.add(normalizedPath);
      routesByPluginAndKey.set(`${plugin.key}:${route.key}`, {
        plugin,
        route,
      });
    }

    for (const definition of plugin.sourceTypes ?? []) {
      if (sourceTypesByKind.has(definition.kind)) {
        throw new Error(
          `Duplicate frontend source kind registration: ${definition.kind}`,
        );
      }

      if (sourceTypesByKey.has(definition.key)) {
        throw new Error(
          `Duplicate frontend source key registration: ${definition.key}`,
        );
      }

      if (definition.detailRoutes) {
        const routeKeys = new Set<string>();

        for (const detailRoute of definition.detailRoutes) {
          if (routeKeys.has(detailRoute.key)) {
            throw new Error(
              `Duplicate frontend source detail route key for ${definition.key}: ${detailRoute.key}`,
            );
          }

          routeKeys.add(detailRoute.key);

          if (normalizeSourcePluginPath(detailRoute.path).length === 0) {
            throw new Error(
              `Frontend source detail route path must be non-empty for ${definition.key}: ${detailRoute.key}`,
            );
          }
        }
      }

      const registeredSourceType: RegisteredFrontendSourceType = {
        plugin,
        definition,
      };

      sourceTypesByKind.set(definition.kind, registeredSourceType);
      sourceTypesByKey.set(definition.key, registeredSourceType);
    }
  }

  const routes = [...routesByPluginAndKey.values()];
  const sourceTypes = [...sourceTypesByKey.values()];

  return {
    plugins: [...pluginsByKey.values()],
    routes,
    sourceTypes,
    getPlugin: (key: string) => pluginsByKey.get(key) ?? null,
    getRoute: (pluginKey: string, routeKey: string) =>
      routesByPluginAndKey.get(`${pluginKey}:${routeKey}`) ?? null,
    getSourceType: (kind: string) => sourceTypesByKind.get(kind) ?? null,
    getSourceTypeByKey: (key: string) => sourceTypesByKey.get(key) ?? null,
    getDefaultSourceType: () => sourceTypes[0] ?? null,
  };
};
