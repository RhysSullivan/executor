import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { createDiscoveryPrimitivesFromToolCatalog } from "./discovery";
import { toTool } from "./tool-map";
import {
  ToolDescriptorSchema,
  ToolNamespaceSchema,
  type ToolCatalog,
  type ToolMap,
  type ToolPath,
} from "./types";

const asToolPath = (value: string): ToolPath => value as ToolPath;

const catalogNamespacesInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    limit: Schema.optional(Schema.Number),
  }),
);

const catalogNamespacesOutputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    namespaces: Schema.Array(ToolNamespaceSchema),
  }),
);

const catalogToolsInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    namespace: Schema.optional(Schema.String),
    query: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    includeSchemas: Schema.optional(Schema.Boolean),
  }),
);

const catalogToolsOutputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    results: Schema.Array(ToolDescriptorSchema),
  }),
);

const describeToolInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    path: Schema.String,
    includeSchemas: Schema.optional(Schema.Boolean),
  }),
);

const describeToolOutputSchema = Schema.standardSchemaV1(
  Schema.NullOr(ToolDescriptorSchema),
);

const discoverInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    includeSchemas: Schema.optional(Schema.Boolean),
  }),
);

const discoverResultItemSchema = Schema.extend(
  ToolDescriptorSchema,
  Schema.Struct({
    score: Schema.Number,
  }),
);

const discoverOutputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    bestPath: Schema.NullOr(Schema.String),
    results: Schema.Array(discoverResultItemSchema),
    total: Schema.Number,
  }),
);

export type DiscoverResultItem = Record<string, unknown> & {
  path: ToolPath;
  score: number;
};

export type CreateSystemToolMapInput = {
  catalog?: ToolCatalog;
  getCatalog?: () => ToolCatalog;
  sourceKey?: string;
  filterDiscoverResults?: (
    results: readonly DiscoverResultItem[],
  ) => Promise<readonly DiscoverResultItem[]> | readonly DiscoverResultItem[];
};

export const createSystemToolMap = (
  input: CreateSystemToolMapInput,
): ToolMap => {
  const sourceKey = input.sourceKey ?? "system";
  const getCatalog = (): ToolCatalog => {
    if (input.catalog) {
      return input.catalog;
    }
    if (input.getCatalog) {
      return input.getCatalog();
    }

    throw new Error("createSystemToolMap requires a catalog or getCatalog");
  };
  const getPrimitives = () =>
    createDiscoveryPrimitivesFromToolCatalog({
      catalog: getCatalog(),
    }) as Required<ReturnType<typeof createDiscoveryPrimitivesFromToolCatalog>>;

  const tools: ToolMap = {};

  tools["catalog.namespaces"] = toTool({
    tool: {
      description: "List available namespaces with display names and tool counts",
      inputSchema: catalogNamespacesInputSchema,
      outputSchema: catalogNamespacesOutputSchema,
      execute: ({ limit }: { limit?: number }) =>
        Effect.runPromise(
          getPrimitives().catalog.namespaces((limit !== undefined ? { limit } : {})),
        ),
    },
    metadata: {
      sourceKey,
      interaction: "auto",
    },
  });

  tools["catalog.tools"] = toTool({
    tool: {
      description: "List tools with optional namespace and query filters",
      inputSchema: catalogToolsInputSchema,
      outputSchema: catalogToolsOutputSchema,
      execute: (
        toolInput: {
          namespace?: string;
          query?: string;
          limit?: number;
          includeSchemas?: boolean;
        },
      ) =>
        Effect.runPromise(
          getPrimitives().catalog.tools({
            ...(toolInput.namespace !== undefined
              ? { namespace: toolInput.namespace }
              : {}),
            ...(toolInput.query !== undefined ? { query: toolInput.query } : {}),
            ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
            ...(toolInput.includeSchemas !== undefined
              ? { includeSchemas: toolInput.includeSchemas }
              : {}),
          }),
        ),
    },
    metadata: {
      sourceKey,
      interaction: "auto",
    },
  });

  tools["describe.tool"] = toTool({
    tool: {
      description: "Get metadata and optional schemas for a tool path",
      inputSchema: describeToolInputSchema,
      outputSchema: describeToolOutputSchema,
      execute: ({ path, includeSchemas }: { path: string; includeSchemas?: boolean }) =>
        Effect.runPromise(
          getPrimitives().describe.tool({
            path: asToolPath(path),
            ...(includeSchemas !== undefined ? { includeSchemas } : {}),
          }),
        ),
    },
    metadata: {
      sourceKey,
      interaction: "auto",
    },
  });

  tools.discover = toTool({
    tool: {
      description: "Search tools by intent and return ranked matches",
      inputSchema: discoverInputSchema,
      outputSchema: discoverOutputSchema,
      execute: async (
        toolInput: {
          query: string;
          limit?: number;
          includeSchemas?: boolean;
        },
      ) => {
        const result = await Effect.runPromise(
          getPrimitives().discover({
            query: toolInput.query,
            ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
            ...(toolInput.includeSchemas !== undefined
              ? { includeSchemas: toolInput.includeSchemas }
              : {}),
          }),
        );

        if (!input.filterDiscoverResults) {
          return result;
        }

        const filtered = await input.filterDiscoverResults(
          result.results as DiscoverResultItem[],
        );

        return {
          ...result,
          results: filtered,
          bestPath: filtered[0]?.path ?? null,
          total: filtered.length,
        };
      },
    },
    metadata: {
      sourceKey,
      interaction: "auto",
    },
  });

  return tools;
};

export type MergeToolMapsOptions = {
  conflictMode?: "throw" | "override";
};

export const mergeToolMaps = (
  maps: ReadonlyArray<ToolMap>,
  options: MergeToolMapsOptions = {},
): ToolMap => {
  const conflictMode = options.conflictMode ?? "throw";
  const merged: ToolMap = {};

  for (const map of maps) {
    for (const [path, tool] of Object.entries(map)) {
      if (conflictMode === "throw" && path in merged) {
        throw new Error(`Tool path conflict: ${path}`);
      }
      merged[path] = tool;
    }
  }

  return merged;
};
