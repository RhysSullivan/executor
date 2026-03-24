import type {
  ExecutorFrontendPlugin,
  FrontendSourceTypeDefinition,
} from "./types";
import {
  normalizeSourcePluginPath,
} from "./paths";

export const defineFrontendSourceType = <
  TDefinition extends FrontendSourceTypeDefinition,
>(
  definition: TDefinition,
): TDefinition => definition;

export const defineExecutorFrontendPlugin = (input: {
  key: string;
  sourceTypes: readonly FrontendSourceTypeDefinition[];
}): ExecutorFrontendPlugin => ({
  key: input.key,
  register(api) {
    for (const sourceType of input.sourceTypes) {
      api.sources.registerType(sourceType);
    }
  },
});

export const registerExecutorFrontendPlugins = (
  plugins: readonly ExecutorFrontendPlugin[],
) => {
  const sourceTypesByKind = new Map<string, FrontendSourceTypeDefinition>();
  const sourceTypesByKey = new Map<string, FrontendSourceTypeDefinition>();

  for (const plugin of plugins) {
    plugin.register({
      sources: {
        registerType(definition) {
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

          sourceTypesByKind.set(definition.kind, definition);
          sourceTypesByKey.set(definition.key, definition);
        },
      },
    });
  }

  const sourceTypes = [...sourceTypesByKey.values()];

  return {
    plugins,
    sourceTypes,
    getSourceType: (kind: string) => sourceTypesByKind.get(kind) ?? null,
    getSourceTypeByKey: (key: string) => sourceTypesByKey.get(key) ?? null,
    getDefaultSourceType: () => sourceTypes[0] ?? null,
  };
};
