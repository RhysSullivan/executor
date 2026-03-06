import * as Effect from "effect/Effect";

import {
  type ToolCatalog,
  type ToolPath,
  createToolCatalogDiscovery,
} from "@executor-v3/codemode-core";

const asToolPath = (value: string): ToolPath => value as ToolPath;

const catalog: ToolCatalog = {
  listNamespaces() {
    return Effect.succeed([
      { namespace: "src_api", displayName: "API Sources", toolCount: 6800 },
      { namespace: "src_mcp", displayName: "MCP Sources", toolCount: 3200 },
    ]);
  },
  listTools({ namespace }) {
    return Effect.succeed([
      {
        path: asToolPath("source.src_api.github.issues.list"),
        sourceKey: "source.src_api",
        description: "Hydrated metadata for selected path",
        inputHint: "object",
        outputHint: "object",
      },
    ].filter((tool) => !namespace || tool.path.startsWith(`source.${namespace}.`)));
  },
  getToolByPath({ path }) {
    return Effect.succeed({
      path,
      sourceKey: "source.src_api",
      description: "Hydrated metadata for selected path",
      inputHint: "object",
      outputHint: "object",
    });
  },
  searchTools({ limit }) {
    return Effect.succeed(
      [
        { path: asToolPath("source.src_api.github.issues.list"), score: 0.99 },
        { path: asToolPath("source.src_api.github.issues.create"), score: 0.92 },
      ].slice(0, limit),
    );
  },
};

export const dynamicDemo = createToolCatalogDiscovery({
  catalog,
});
