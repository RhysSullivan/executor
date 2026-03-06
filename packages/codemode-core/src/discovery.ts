import * as Effect from "effect/Effect";

import { toolDescriptorsFromTools } from "./tool-map";
import type {
  CatalogPrimitive,
  DescribePrimitive,
  DiscoverPrimitive,
  DiscoveryPrimitives,
  ToolCatalog,
  ToolDescriptor,
  ToolMap,
  ToolPath,
} from "./types";

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/\W+/)
    .map((token) => token.trim())
    .filter(Boolean);

const searchableTextForTool = (tool: ToolDescriptor): string =>
  [
    tool.path,
    tool.sourceKey,
    tool.description ?? "",
    tool.inputHint ?? "",
    tool.outputHint ?? "",
  ]
    .join(" ")
    .toLowerCase();

const projectDescriptor = (input: {
  descriptor: ToolDescriptor;
  includeSchemas: boolean;
}): ToolDescriptor => {
  const { descriptor, includeSchemas } = input;

  if (includeSchemas) {
    return descriptor;
  }

  return {
    ...descriptor,
    inputSchemaJson: undefined,
    outputSchemaJson: undefined,
    refHintKeys: undefined,
  };
};

const formatToolLine = (tool: ToolDescriptor): string =>
  tool.description && tool.description.trim().length > 0
    ? `- ${tool.path}: ${tool.description.trim()}`
    : `- ${tool.path}`;

const namespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

export function createToolCatalogFromTools(input: {
  tools: ToolMap;
  defaultNamespace?: string;
}): ToolCatalog {
  const descriptors = toolDescriptorsFromTools({
    tools: input.tools,
  });
  const byPath = new Map(descriptors.map((descriptor) => [descriptor.path as string, descriptor]));
  const namespaceCounts = new Map<string, number>();

  for (const descriptor of descriptors) {
    const namespace = input.defaultNamespace ?? namespaceFromPath(descriptor.path);
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
  }

  return {
    listNamespaces: ({ limit }) =>
      Effect.succeed(
        [...namespaceCounts.entries()]
          .map(([namespace, toolCount]) => ({ namespace, toolCount }))
          .slice(0, limit),
      ),
    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      Effect.succeed(
        descriptors
          .filter((descriptor) => {
            const descriptorNamespace = input.defaultNamespace ?? namespaceFromPath(descriptor.path);
            return !namespace || descriptorNamespace === namespace;
          })
          .filter((descriptor) => {
            if (!query) {
              return true;
            }

            const haystack = searchableTextForTool(descriptor);
            return tokenize(query).every((token) => haystack.includes(token));
          })
          .slice(0, limit)
          .map((descriptor) =>
            projectDescriptor({
              descriptor,
              includeSchemas,
            })
          ),
      ),
    getToolByPath: ({ path, includeSchemas }) =>
      Effect.succeed(
        byPath.get(path)
          ? projectDescriptor({
              descriptor: byPath.get(path)!,
              includeSchemas,
            })
          : null,
      ),
    searchTools: ({ query, namespace, limit }) => {
      const queryTokens = tokenize(query);

      return Effect.succeed(
        descriptors
          .filter((descriptor) => {
            const descriptorNamespace = input.defaultNamespace ?? namespaceFromPath(descriptor.path);
            return !namespace || descriptorNamespace === namespace;
          })
          .map((descriptor) => {
            const haystack = searchableTextForTool(descriptor);
            const score = queryTokens.reduce(
              (total, token) => total + (haystack.includes(token) ? 1 : 0),
              0,
            );

            return {
              path: descriptor.path,
              score,
            };
          })
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit),
      );
    },
  } satisfies ToolCatalog;
}

export function createStaticDiscoveryFromTools(input: {
  tools: ToolMap;
  sourceKey?: string;
}): {
  tools: ToolDescriptor[];
  executeDescription: Effect.Effect<string, never>;
} {
  const tools = toolDescriptorsFromTools({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });

  return {
    tools,
    executeDescription: Effect.succeed(buildStaticExecuteDescription({ tools })),
  };
}

export function createToolCatalogDiscovery(input: {
  catalog: ToolCatalog;
}): {
  primitives: DiscoveryPrimitives;
  executeDescription: Effect.Effect<string, unknown>;
} {
  const primitives = createDiscoveryPrimitivesFromToolCatalog({
    catalog: input.catalog,
  });

  return {
    primitives,
    executeDescription: buildDynamicExecuteDescription({
      catalog: input.catalog,
    }),
  };
}

export function createDiscoveryPrimitivesFromToolCatalog(input: {
  catalog: ToolCatalog;
}): DiscoveryPrimitives {
  const { catalog } = input;

  const describe: DescribePrimitive = {
    tool: ({ path, includeSchemas = false }) =>
      catalog.getToolByPath({ path, includeSchemas }),
  };

  const discover: DiscoverPrimitive = ({
    query,
    sourceKey: _sourceKey,
    limit = 12,
    includeSchemas = false,
  }) =>
    Effect.gen(function* () {
      const hits = yield* catalog.searchTools({
        query,
        limit,
      });

      if (hits.length === 0) {
        return {
          bestPath: null,
          results: [],
          total: 0,
        };
      }

      const descriptors = yield* Effect.forEach(
        hits,
        (hit) =>
          catalog.getToolByPath({
            path: hit.path,
            includeSchemas,
          }),
        { concurrency: "unbounded" },
      );

      const hydrated = hits
        .map((hit, index) => {
          const descriptor = descriptors[index];
          if (!descriptor) {
            return null;
          }

          return {
            path: descriptor.path,
            score: hit.score,
            description: descriptor.description,
            interaction: descriptor.interaction ?? "auto",
            inputHint: descriptor.inputHint,
            outputHint: descriptor.outputHint,
            ...(includeSchemas
              ? {
                  inputSchemaJson: descriptor.inputSchemaJson,
                  outputSchemaJson: descriptor.outputSchemaJson,
                  refHintKeys: descriptor.refHintKeys,
                }
              : {}),
          };
        })
        .filter(Boolean) as Array<
        Record<string, unknown> & { path: ToolPath; score: number }
      >;

      return {
        bestPath: hydrated[0]?.path ?? null,
        results: hydrated,
        total: hydrated.length,
      };
    });

  const catalogPrimitive: CatalogPrimitive = {
    namespaces: ({ limit = 200 }) =>
      catalog.listNamespaces({ limit }).pipe(
        Effect.map((namespaces) => ({ namespaces })),
      ),
    tools: ({ namespace, query, limit = 200, includeSchemas = false }) =>
      catalog.listTools({
        ...(namespace !== undefined ? { namespace } : {}),
        ...(query !== undefined ? { query } : {}),
        limit,
        includeSchemas,
      }).pipe(
        Effect.map((results) => ({ results })),
      ),
  };

  return {
    catalog: catalogPrimitive,
    describe,
    discover,
  };
}

export function buildStaticExecuteDescription(input: {
  tools: readonly ToolDescriptor[];
}): string {
  return [
    "Execute TypeScript in sandbox; call tools directly.",
    "Available tools:",
    ...input.tools.map(formatToolLine),
    "Do not use fetch; use tools.* only.",
  ].join("\n");
}

export function buildDynamicExecuteDescription(input: {
  catalog: ToolCatalog;
}): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const namespaces = yield* input.catalog.listNamespaces({ limit: 200 });

    return [
      "Execute TypeScript in sandbox; call tools via discovery workflow.",
      "Available namespaces:",
      ...namespaces.map((namespace) => `- ${namespace.displayName ?? namespace.namespace}`),
      "Workflow:",
      '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
      "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
      "3) Call selected tools.<path>(input).",
      "Do not use fetch; use tools.* only.",
    ].join("\n");
  });
}
