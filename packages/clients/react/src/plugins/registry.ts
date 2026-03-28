import type {
  ExecutorFrontendPlugin,
  FrontendPluginRouteDefinition,
} from "./types";
import {
  normalizeExecutorPluginPath,
} from "./paths";

export type RegisteredFrontendPluginRoute = {
  plugin: ExecutorFrontendPlugin;
  route: FrontendPluginRouteDefinition;
};

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
  }

  const routes = [...routesByPluginAndKey.values()];

  return {
    plugins: [...pluginsByKey.values()],
    routes,
    getPlugin: (key: string) => pluginsByKey.get(key) ?? null,
    getRoute: (pluginKey: string, routeKey: string) =>
      routesByPluginAndKey.get(`${pluginKey}:${routeKey}`) ?? null,
  };
};
