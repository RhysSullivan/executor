import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import type { DiscoveryTypingPayload } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import {
  RuntimeAdapterError,
  type RuntimeToolCallService,
} from "./runtime-adapters";

export type ToolRegistryCallInput = {
  runId: string;
  callId: string;
  toolPath: string;
  input?: Record<string, unknown>;
};

export type ToolRegistryDiscoverInput = {
  query?: string;
  limit?: number;
  compact?: boolean;
  includeSchemas?: boolean;
};

export type ToolRegistryCatalogNamespacesInput = {
  limit?: number;
};

export type ToolRegistryCatalogToolsInput = {
  namespace?: string;
  query?: string;
  limit?: number;
  compact?: boolean;
  includeSchemas?: boolean;
};

export type ToolRegistryToolSummary = {
  path: string;
  source?: string;
  approval: "auto" | "required";
  description?: string;
  inputHint?: string;
  outputHint?: string;
  typing?: DiscoveryTypingPayload;
};

export type ToolRegistryDiscoverOutput = {
  bestPath: string | null;
  results: Array<ToolRegistryToolSummary>;
  total: number;
  refHintTable?: Record<string, string>;
};

export type ToolRegistryCatalogNamespacesOutput = {
  namespaces: Array<{
    namespace: string;
    toolCount: number;
    samplePaths: Array<string>;
  }>;
  total: number;
};

export type ToolRegistryCatalogToolsOutput = {
  results: Array<ToolRegistryToolSummary>;
  total: number;
  refHintTable?: Record<string, string>;
};

export type ToolRegistry = {
  callTool: (
    input: ToolRegistryCallInput,
  ) => Effect.Effect<RuntimeToolCallResult, RuntimeAdapterError>;
  discover: (
    input: ToolRegistryDiscoverInput,
  ) => Effect.Effect<ToolRegistryDiscoverOutput, RuntimeAdapterError>;
  catalogNamespaces: (
    input: ToolRegistryCatalogNamespacesInput,
  ) => Effect.Effect<ToolRegistryCatalogNamespacesOutput, RuntimeAdapterError>;
  catalogTools: (
    input: ToolRegistryCatalogToolsInput,
  ) => Effect.Effect<ToolRegistryCatalogToolsOutput, RuntimeAdapterError>;
};

export type InMemorySandboxTool = {
  description?: string | null;
  execute?: (...args: Array<any>) => Promise<any> | any;
  typing?: DiscoveryTypingPayload;
};

export type InMemorySandboxToolMap = Record<string, InMemorySandboxTool>;

type StaticToolRegistryOptions = {
  tools: InMemorySandboxToolMap;
  refHintTable?: Record<string, string>;
};

const staticToolRegistryRuntimeKind = "static-tool-registry";
const runtimeToolCallServiceRuntimeKind = "tool-registry-runtime-tool-call-service";

const toRuntimeAdapterError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    runtimeKind: staticToolRegistryRuntimeKind,
    operation,
    message,
    details,
  });

const normalizeObjectInput = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
};

const normalizeDiscoverInput = (input: unknown): ToolRegistryDiscoverInput => {
  const value = normalizeObjectInput(input);
  return {
    query: typeof value.query === "string" ? value.query : undefined,
    limit: typeof value.limit === "number" ? value.limit : undefined,
    compact: typeof value.compact === "boolean" ? value.compact : undefined,
    includeSchemas:
      typeof value.includeSchemas === "boolean" ? value.includeSchemas : undefined,
  };
};

const normalizeCatalogNamespacesInput = (
  input: unknown,
): ToolRegistryCatalogNamespacesInput => {
  const value = normalizeObjectInput(input);
  return {
    limit: typeof value.limit === "number" ? value.limit : undefined,
  };
};

const normalizeCatalogToolsInput = (input: unknown): ToolRegistryCatalogToolsInput => {
  const value = normalizeObjectInput(input);
  return {
    namespace: typeof value.namespace === "string" ? value.namespace : undefined,
    query: typeof value.query === "string" ? value.query : undefined,
    limit: typeof value.limit === "number" ? value.limit : undefined,
    compact: typeof value.compact === "boolean" ? value.compact : undefined,
    includeSchemas:
      typeof value.includeSchemas === "boolean" ? value.includeSchemas : undefined,
  };
};

const parseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const deriveHintFromSchemaJson = (
  schemaJson: string | undefined,
  fallback: string,
): string => {
  if (!schemaJson) {
    return fallback;
  }

  const schema = parseJson(schemaJson);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return fallback;
  }

  const schemaRecord = schema as Record<string, unknown>;
  const title = schemaRecord.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim();
  }

  const type = schemaRecord.type;
  if (type === "object") {
    const properties = schemaRecord.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const keys = Object.keys(properties);
      if (keys.length > 0) {
        const shown = keys.slice(0, 3).join(", ");
        return keys.length <= 3
          ? `object { ${shown} }`
          : `object { ${shown}, ... }`;
      }
    }

    return "object";
  }

  if (type === "array") {
    return "array";
  }

  if (typeof type === "string") {
    return type;
  }

  return fallback;
};

const includeTyping = (
  typing: DiscoveryTypingPayload | undefined,
  includeSchemas: boolean,
): DiscoveryTypingPayload | undefined => {
  if (!includeSchemas) {
    return undefined;
  }

  return typing;
};

const summarizeTool = (
  path: string,
  source: string,
  description: string | undefined,
  typing: DiscoveryTypingPayload | undefined,
  includeSchemas: boolean,
  compact: boolean,
): ToolRegistryToolSummary => ({
  path,
  source,
  approval: "auto",
  description: compact ? undefined : description,
  inputHint: compact
    ? undefined
    : deriveHintFromSchemaJson(typing?.inputSchemaJson, "input"),
  outputHint: compact
    ? undefined
    : deriveHintFromSchemaJson(typing?.outputSchemaJson, "output"),
  typing: includeTyping(typing, includeSchemas),
});

const collectRequestedRefKeys = (
  results: ReadonlyArray<ToolRegistryToolSummary>,
): Array<string> => {
  const set = new Set<string>();
  for (const result of results) {
    for (const key of result.typing?.refHintKeys ?? []) {
      set.add(key);
    }
  }

  return [...set].sort();
};

const selectRefHintTable = (
  refHintTable: Record<string, string> | undefined,
  results: ReadonlyArray<ToolRegistryToolSummary>,
  includeSchemas: boolean,
): Record<string, string> | undefined => {
  if (!includeSchemas || !refHintTable) {
    return undefined;
  }

  const keys = collectRequestedRefKeys(results);
  if (keys.length === 0) {
    return undefined;
  }

  const filtered: Record<string, string> = {};
  for (const key of keys) {
    const value = refHintTable[key];
    if (value !== undefined) {
      filtered[key] = value;
    }
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
};

type StaticToolEntry = {
  path: string;
  description: string | undefined;
  typing: DiscoveryTypingPayload | undefined;
};

const asStaticEntries = (tools: InMemorySandboxToolMap): Array<StaticToolEntry> =>
  Object.entries(tools)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([path, tool]) => ({
      path,
      description: tool.description ?? undefined,
      typing: tool.typing,
    }));

const scorePath = (
  entry: { path: string; description?: string },
  query: string,
): number => {
  if (query.length === 0) {
    return 1;
  }

  const lowerPath = entry.path.toLowerCase();
  const lowerDescription = (entry.description ?? "").toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerPath === lowerQuery) {
    return 100;
  }

  if (lowerPath.startsWith(lowerQuery)) {
    return 80;
  }

  if (lowerPath.includes(lowerQuery)) {
    return 60;
  }

  if (lowerDescription.includes(lowerQuery)) {
    return 40;
  }

  return 0;
};

const inMemoryDiscover = (
  tools: InMemorySandboxToolMap,
  refHintTable: Record<string, string> | undefined,
  input: ToolRegistryDiscoverInput,
): ToolRegistryDiscoverOutput => {
  const limit = Math.max(1, Math.min(50, input.limit ?? 8));
  const query = (input.query ?? "").trim().toLowerCase();
  const includeSchemas = input.includeSchemas === true;
  const compact = input.compact === true;

  const ranked = asStaticEntries(tools)
    .map((entry) => ({
      entry,
      score: scorePath(entry, query),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) =>
      summarizeTool(
        item.entry.path,
        "in-memory",
        item.entry.description,
        item.entry.typing,
        includeSchemas,
        compact,
      ),
    );

  return {
    bestPath: ranked[0]?.path ?? null,
    results: ranked,
    total: ranked.length,
    refHintTable: selectRefHintTable(refHintTable, ranked, includeSchemas),
  };
};

const inMemoryCatalogNamespaces = (
  tools: InMemorySandboxToolMap,
  input: ToolRegistryCatalogNamespacesInput,
): ToolRegistryCatalogNamespacesOutput => {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const grouped = new Map<string, Array<string>>();

  for (const path of Object.keys(tools)) {
    const namespace = path.split(".")[0] ?? "default";
    const list = grouped.get(namespace) ?? [];
    list.push(path);
    grouped.set(namespace, list);
  }

  const namespaces = [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([namespace, paths]) => ({
      namespace,
      toolCount: paths.length,
      samplePaths: [...paths].sort((left, right) => left.localeCompare(right)).slice(0, 3),
    }));

  return {
    namespaces: namespaces.slice(0, limit),
    total: namespaces.length,
  };
};

const inMemoryCatalogTools = (
  tools: InMemorySandboxToolMap,
  refHintTable: Record<string, string> | undefined,
  input: ToolRegistryCatalogToolsInput,
): ToolRegistryCatalogToolsOutput => {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const query = (input.query ?? "").trim().toLowerCase();
  const namespace = (input.namespace ?? "").trim().toLowerCase();
  const includeSchemas = input.includeSchemas === true;
  const compact = input.compact === true;

  const filtered = asStaticEntries(tools)
    .filter((entry) => {
      if (namespace.length > 0) {
        const entryNamespace = entry.path.split(".")[0]?.toLowerCase() ?? "";
        if (entryNamespace !== namespace) {
          return false;
        }
      }

      return scorePath(entry, query) > 0;
    })
    .slice(0, limit)
    .map((entry) =>
      summarizeTool(
        entry.path,
        "in-memory",
        entry.description,
        entry.typing,
        includeSchemas,
        compact,
      ),
    );

  return {
    results: filtered,
    total: filtered.length,
    refHintTable: selectRefHintTable(refHintTable, filtered, includeSchemas),
  };
};

export const createStaticToolRegistry = (
  options: StaticToolRegistryOptions,
): ToolRegistry => ({
  callTool: (input) => {
    const implementation = options.tools[input.toolPath];
    if (!implementation) {
      return Effect.succeed<RuntimeToolCallResult>({
        ok: false,
        kind: "failed",
        error: `Unknown in-memory tool: ${input.toolPath}`,
      });
    }

    if (!implementation.execute) {
      return Effect.succeed<RuntimeToolCallResult>({
        ok: false,
        kind: "failed",
        error: `In-memory tool '${input.toolPath}' has no execute function`,
      });
    }

    return Effect.tryPromise({
      try: () => Promise.resolve(implementation.execute!(input.input ?? {}, undefined)),
      catch: (cause) =>
        toRuntimeAdapterError(
          "call_tool",
          `In-memory tool invocation failed: ${input.toolPath}`,
          String(cause),
        ),
    }).pipe(
      Effect.map(
        (value): RuntimeToolCallResult => ({
          ok: true,
          value,
        }),
      ),
    );
  },
  discover: (input) =>
    Effect.succeed(inMemoryDiscover(options.tools, options.refHintTable, input)),
  catalogNamespaces: (input) =>
    Effect.succeed(inMemoryCatalogNamespaces(options.tools, input)),
  catalogTools: (input) =>
    Effect.succeed(inMemoryCatalogTools(options.tools, options.refHintTable, input)),
});

export const createRuntimeToolCallResultHandler = (
  request: RuntimeToolCallRequest,
  result: RuntimeToolCallResult,
): Effect.Effect<unknown, RuntimeAdapterError> => {
  if (result.ok) {
    return Effect.succeed(result.value);
  }

  if (result.kind === "pending") {
    return Effect.fail(
      new RuntimeAdapterError({
        operation: "call_tool",
        runtimeKind: runtimeToolCallServiceRuntimeKind,
        message: result.error ?? `Tool call requires approval: ${request.toolPath}`,
        details: `approvalId=${result.approvalId} retryAfterMs=${result.retryAfterMs}`,
      }),
    );
  }

  if (result.kind === "denied") {
    return Effect.fail(
      new RuntimeAdapterError({
        operation: "call_tool",
        runtimeKind: runtimeToolCallServiceRuntimeKind,
        message: result.error,
        details: `Tool call denied: ${request.toolPath}`,
      }),
    );
  }

  return Effect.fail(
    new RuntimeAdapterError({
      operation: "call_tool",
      runtimeKind: runtimeToolCallServiceRuntimeKind,
      message: result.error,
      details: `Tool call failed: ${request.toolPath}`,
    }),
  );
};

export const createRuntimeToolCallService = (
  toolRegistry: ToolRegistry,
): RuntimeToolCallService => ({
  callTool: (input) => {
    if (input.toolPath === "discover") {
      return toolRegistry.discover(normalizeDiscoverInput(input.input));
    }

    if (input.toolPath === "catalog.namespaces") {
      return toolRegistry.catalogNamespaces(
        normalizeCatalogNamespacesInput(input.input),
      );
    }

    if (input.toolPath === "catalog.tools") {
      return toolRegistry.catalogTools(normalizeCatalogToolsInput(input.input));
    }

    return toolRegistry
      .callTool(input)
      .pipe(Effect.flatMap((result) => createRuntimeToolCallResultHandler(input, result)));
  },
});
