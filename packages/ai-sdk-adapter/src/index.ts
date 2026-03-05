import type { ToolSet } from "ai";

export type ToolPath = string & { readonly __toolPath: unique symbol };

export type ToolDescriptor = {
  path: ToolPath;
  sourceKey: string;
  description?: string;
  interaction?: "auto" | "required";
  inputHint?: string;
  outputHint?: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  refHintKeys?: readonly string[];
};

export type ExecutorAiSdkMetadata = {
  interaction?: "auto" | "required";
  inputHint?: string;
  outputHint?: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  refHintKeys?: readonly string[];
  sourceKey?: string;
};

export type AiSdkToolMap = ToolSet;

export type ExecutorToolDefinition = {
  tool: ToolSet[string];
  metadata?: ExecutorAiSdkMetadata;
};

export type ExecutorToolInput = ToolSet[string] | ExecutorToolDefinition;

export type ExecutorToolMap = Record<string, ExecutorToolInput>;

type ResolvedExecutorTool = {
  path: ToolPath;
  tool: ToolSet[string];
  metadata?: ExecutorAiSdkMetadata;
};

export type SearchHit = {
  path: ToolPath;
  score: number;
};

export interface SearchProvider {
  search(input: {
    query: string;
    limit: number;
  }): Promise<readonly SearchHit[]>;
}

export interface ToolDirectory {
  listNamespaces(input: {
    limit: number;
  }): Promise<readonly { namespace: string; toolCount: number }[]>;

  listTools(input: {
    namespace?: string;
    query?: string;
    limit: number;
  }): Promise<readonly { path: ToolPath }[]>;

  getByPath(input: {
    path: ToolPath;
    includeSchemas: boolean;
  }): Promise<ToolDescriptor | null>;

  getByPaths(input: {
    paths: readonly ToolPath[];
    includeSchemas: boolean;
  }): Promise<readonly ToolDescriptor[]>;
}

export type CatalogPrimitive = {
  namespaces(input: {
    limit?: number;
  }): Promise<{ namespaces: readonly { namespace: string; toolCount: number }[] }>;
  tools(input: {
    namespace?: string;
    query?: string;
    limit?: number;
  }): Promise<{ results: readonly { path: ToolPath }[] }>;
};

export type DescribePrimitive = {
  tool(input: {
    path: ToolPath;
    includeSchemas?: boolean;
  }): Promise<ToolDescriptor | null>;
};

export type DiscoverPrimitive = {
  run(input: {
    query: string;
    limit?: number;
    includeSchemas?: boolean;
  }): Promise<{
    bestPath: ToolPath | null;
    results: readonly (Record<string, unknown> & {
      path: ToolPath;
      score: number;
    })[];
    total: number;
  }>;
};

export type DiscoveryPrimitives = {
  catalog?: CatalogPrimitive;
  describe?: DescribePrimitive;
  discover?: DiscoverPrimitive;
};

const asToolPath = (value: string): ToolPath => value as ToolPath;

export function wrapTool(input: {
  tool: ToolSet[string];
  metadata?: ExecutorAiSdkMetadata;
}): ExecutorToolDefinition {
  return {
    tool: input.tool,
    metadata: input.metadata,
  };
}

export const toExecutorTool = wrapTool;

const isExecutorToolDefinition = (
  value: ExecutorToolInput,
): value is ExecutorToolDefinition =>
  typeof value === "object" && value !== null && "tool" in value;

const stringifySchema = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const inferHintFromSchemaJson = (
  schemaJson: string | undefined,
  fallback: string,
): string => {
  if (!schemaJson) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(schemaJson) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (title.length > 0) {
      return title;
    }

    if (parsed.type === "object") {
      const properties =
        parsed.properties &&
        typeof parsed.properties === "object" &&
        !Array.isArray(parsed.properties)
          ? Object.keys(parsed.properties as Record<string, unknown>)
          : [];
      if (properties.length > 0) {
        const shown = properties.slice(0, 3).join(", ");
        return properties.length <= 3
          ? `object { ${shown} }`
          : `object { ${shown}, ... }`;
      }
      return "object";
    }

    if (parsed.type === "array") {
      return "array";
    }

    if (typeof parsed.type === "string") {
      return parsed.type;
    }
  } catch {
    // Ignore malformed schema and fall back.
  }

  return fallback;
};

export function createToolsFromAiSdkTools(input: {
  tools: AiSdkToolMap;
  sourceKey?: string;
}): ExecutorToolMap {
  const { tools, sourceKey = "in_memory.ai_sdk" } = input;

  return Object.fromEntries(
    Object.entries(tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tool]) => [
        path,
        wrapTool({
          tool,
          metadata: { sourceKey },
        }),
      ]),
  ) as ExecutorToolMap;
}

const resolveToolsFromMap = (input: {
  tools: ExecutorToolMap;
  sourceKey?: string;
}): ResolvedExecutorTool[] => {
  const defaultSourceKey = input.sourceKey ?? "in_memory.ai_sdk";

  return Object.entries(input.tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => {
      const entry = isExecutorToolDefinition(value)
        ? value
        : { tool: value };
      const metadata = entry.metadata
        ? {
            sourceKey: defaultSourceKey,
            ...entry.metadata,
          }
        : { sourceKey: defaultSourceKey };

      return {
        path: asToolPath(path),
        tool: entry.tool,
        metadata,
      } satisfies ResolvedExecutorTool;
    });
};

export function toolDescriptorsFromTools(input: {
  tools: ExecutorToolMap;
  sourceKey?: string;
}): ToolDescriptor[] {
  const resolvedTools = resolveToolsFromMap({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });

  return resolvedTools.map((entry) => {
    const metadata = entry.metadata;
    const definition = entry.tool;
    const inputSchemaJson =
      metadata?.inputSchemaJson ??
      stringifySchema((definition as { inputSchema?: unknown }).inputSchema) ??
      stringifySchema((definition as { parameters?: unknown }).parameters);
    const outputSchemaJson =
      metadata?.outputSchemaJson ??
      stringifySchema((definition as { outputSchema?: unknown }).outputSchema);

    return {
      path: entry.path,
      sourceKey: metadata?.sourceKey ?? "in_memory.ai_sdk",
      description: (definition as { description?: string }).description,
      interaction: metadata?.interaction,
      inputHint:
        metadata?.inputHint ?? inferHintFromSchemaJson(inputSchemaJson, "input"),
      outputHint:
        metadata?.outputHint ?? inferHintFromSchemaJson(outputSchemaJson, "output"),
      inputSchemaJson,
      outputSchemaJson,
      refHintKeys: metadata?.refHintKeys,
    } satisfies ToolDescriptor;
  });
}

export function createStaticDiscoveryFromTools(input: {
  tools: ExecutorToolMap;
  sourceKey?: string;
}): {
  preloadedTools: ToolDescriptor[];
  primitives: DiscoveryPrimitives;
  executeDescription: string;
} {
  const preloadedTools = toolDescriptorsFromTools({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });
  const primitives = createDiscoveryPrimitives({});

  return {
    preloadedTools,
    primitives,
    executeDescription: buildExecuteDescription({
      preloadedTools,
      primitives,
    }),
  };
}

export function createDynamicDiscovery(input: {
  directory: ToolDirectory;
  search?: SearchProvider;
  preloadedTools?: readonly ToolDescriptor[];
}): {
  preloadedTools: readonly ToolDescriptor[];
  primitives: DiscoveryPrimitives;
  executeDescription: string;
} {
  const preloadedTools = input.preloadedTools ?? [];
  const primitives = createDiscoveryPrimitives({
    directory: input.directory,
    search: input.search,
  });

  return {
    preloadedTools,
    primitives,
    executeDescription: buildExecuteDescription({
      preloadedTools,
      primitives,
    }),
  };
}

export function createDiscoveryPrimitives(input: {
  directory?: ToolDirectory;
  search?: SearchProvider;
}): DiscoveryPrimitives {
  const { directory, search } = input;

  const catalog: CatalogPrimitive | undefined = directory
    ? {
        namespaces: async ({ limit = 200 }) => ({
          namespaces: await directory.listNamespaces({ limit }),
        }),
        tools: async ({ namespace, query, limit = 200 }) => ({
          results: await directory.listTools({ namespace, query, limit }),
        }),
      }
    : undefined;

  const describe: DescribePrimitive | undefined = directory
    ? {
        tool: async ({ path, includeSchemas = false }) =>
          directory.getByPath({ path, includeSchemas }),
      }
    : undefined;

  const discover: DiscoverPrimitive | undefined =
    directory && search
      ? {
          run: async ({ query, limit = 12, includeSchemas = false }) => {
            const hits = await search.search({ query, limit });
            const descriptors = await directory.getByPaths({
              paths: hits.map((hit) => hit.path),
              includeSchemas,
            });

            const byPath = new Map(
              descriptors.map((descriptor) => [descriptor.path, descriptor]),
            );
            const hydrated = hits
              .map((hit) => {
                const descriptor = byPath.get(hit.path);
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
          },
        }
      : undefined;

  return { catalog, describe, discover };
}

export function buildExecuteDescription(input: {
  preloadedTools: readonly ToolDescriptor[];
  primitives: DiscoveryPrimitives;
}): string {
  const { preloadedTools, primitives } = input;
  const hasCatalog = Boolean(primitives.catalog);
  const hasDescribe = Boolean(primitives.describe);
  const hasDiscover = Boolean(primitives.discover);

  if (!hasCatalog && !hasDescribe && !hasDiscover) {
    return [
      "Execute TypeScript in sandbox; call tools directly.",
      "Available tool paths:",
      ...preloadedTools.map((tool) => `- ${tool.path}`),
      "Do not use fetch; use tools.* only.",
    ].join("\n");
  }

  return [
    "Execute TypeScript in sandbox; call tools via helper workflow.",
    "Workflow:",
    hasCatalog
      ? "1) const namespaces = await tools.catalog.namespaces({ limit: 200 });"
      : "",
    hasDiscover
      ? '2) const matches = await tools.discover.run({ query: "<intent>", limit: 12 });'
      : '2) const toolsList = await tools.catalog.tools({ query: "<intent>", limit: 50 });',
    hasDescribe
      ? "3) const details = await tools.describe.tool({ path, includeSchemas: true });"
      : "",
    "4) Call selected tools.<path>(input).",
    "Do not use fetch; use tools.* only.",
  ]
    .filter(Boolean)
    .join("\n");
}
