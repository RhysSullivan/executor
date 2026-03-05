import type {
  RuntimeToolCallCredentialContext,
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
  credentialContext?: RuntimeToolCallCredentialContext;
  credentialHeaders?: Readonly<Record<string, string>>;
};

export type ToolRegistryDiscoverDepth = 0 | 1 | 2;

export type ToolRegistryDiscoverQueryInput = {
  text: string;
  depth?: ToolRegistryDiscoverDepth;
};

export type ToolRegistryDiscoverInput = {
  query?: string;
  queries?: Array<ToolRegistryDiscoverQueryInput>;
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
  interaction: "auto" | "required";
  description?: string;
  inputHint?: string;
  outputHint?: string;
  typing?: DiscoveryTypingPayload;
};

export type ToolRegistryDiscoverQueryResult = {
  text: string;
  depth: ToolRegistryDiscoverDepth;
  bestPath: string | null;
  results: Array<ToolRegistryToolSummary>;
  total: number;
};

export type ToolRegistryDiscoverOutput = {
  bestPath: string | null;
  results: Array<ToolRegistryToolSummary>;
  total: number;
  perQuery: Array<ToolRegistryDiscoverQueryResult>;
  refHintTable?: Record<string, string>;
};

export type ToolRegistryNamespaceSummary = {
  namespace: string;
  toolCount: number;
  samplePaths: Array<string>;
  source?: string;
  sourceKey?: string;
  description?: string;
};

export type ToolRegistryCatalogNamespacesOutput = {
  namespaces: Array<ToolRegistryNamespaceSummary>;
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

export type ToolInteractionMode = "auto" | "required";

export type ToolInteractionRequest = {
  runId: string;
  callId: string;
  toolPath: string;
  input?: Record<string, unknown>;
  workspaceId?: string;
  source?: string;
  defaultMode: ToolInteractionMode;
  interactionMode?: "form" | "url";
  interactionMessage?: string;
  interactionRequestedSchemaJson?: string | null;
  interactionUrl?: string | null;
  interactionRequestJson?: string | null;
};

export type ToolInteractionDecision =
  | {
      kind: "approved";
    }
  | {
      kind: "pending";
      interactionId: string;
      retryAfterMs?: number;
      error?: string;
    }
  | {
      kind: "denied";
      error: string;
    };

export type ToolInteractionPolicy = {
  evaluate: (
    input: ToolInteractionRequest,
  ) => ToolInteractionDecision | Promise<ToolInteractionDecision>;
};

export type CreateInMemoryToolInteractionPolicyOptions = {
  decide: (
    input: ToolInteractionRequest,
  ) => ToolInteractionDecision | Promise<ToolInteractionDecision>;
};

export type InMemorySandboxTool = {
  description?: string | null;
  interaction?: ToolInteractionMode;
  execute?: (...args: Array<any>) => Promise<any> | any;
  typing?: DiscoveryTypingPayload;
};

export type InMemorySandboxToolMap = Record<string, InMemorySandboxTool>;

type StaticToolRegistryOptions = {
  tools: InMemorySandboxToolMap;
  refHintTable?: Record<string, string>;
  workspaceId?: string;
  interactionPolicy?: ToolInteractionPolicy;
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

const defaultPendingRetryAfterMs = 1_000;
const maxCatalogNamespacesLimit = 5_000;
const maxCatalogToolsLimit = 50_000;

const normalizePendingRetryAfterMs = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return defaultPendingRetryAfterMs;
  }

  return Math.round(value);
};

const normalizeDeniedError = (value: string | undefined, toolPath: string): string => {
  const normalized = value?.trim();
  if (normalized && normalized.length > 0) {
    return normalized;
  }

  return `Tool call denied: ${toolPath}`;
};

const evaluateToolInteraction = (
  request: ToolInteractionRequest,
  policy: ToolInteractionPolicy | undefined,
): Effect.Effect<ToolInteractionDecision, RuntimeAdapterError> => {
  if (!policy) {
    if (request.defaultMode === "required") {
      return Effect.succeed({
        kind: "denied",
        error: `Tool requires interaction gating but no interaction policy is configured: ${request.toolPath}`,
      });
    }

    return Effect.succeed({ kind: "approved" });
  }

  return Effect.tryPromise({
    try: () => Promise.resolve(policy.evaluate(request)),
    catch: (cause) =>
      toRuntimeAdapterError(
        "evaluate_interaction",
        `Tool interaction evaluation failed: ${request.toolPath}`,
        String(cause),
      ),
  });
};

const toToolCallResultFromDecision = (
  decision: ToolInteractionDecision,
  request: ToolInteractionRequest,
): RuntimeToolCallResult => {
  if (decision.kind === "approved") {
    return {
      ok: true,
      value: undefined,
    };
  }

  if (decision.kind === "pending") {
    return {
      ok: false,
      kind: "pending",
      interactionId: decision.interactionId,
      retryAfterMs: normalizePendingRetryAfterMs(decision.retryAfterMs),
      error: decision.error,
    };
  }

  return {
    ok: false,
    kind: "denied",
    error: normalizeDeniedError(decision.error, request.toolPath),
  };
};

export const createInMemoryToolInteractionPolicy = (
  options: CreateInMemoryToolInteractionPolicyOptions,
): ToolInteractionPolicy => ({
  evaluate: (input) => options.decide(input),
});

const normalizeObjectInput = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
};

const normalizeDiscoverDepth = (value: unknown): ToolRegistryDiscoverDepth => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 2) {
    return 2;
  }

  return 1;
};

const normalizeDiscoverQueryInput = (
  input: unknown,
): ToolRegistryDiscoverQueryInput | null => {
  if (typeof input === "string") {
    return {
      text: input,
      depth: 1,
    };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const value = input as Record<string, unknown>;
  const rawText =
    typeof value.text === "string"
      ? value.text
      : typeof value.query === "string"
        ? value.query
        : typeof value.string === "string"
          ? value.string
          : null;

  if (rawText === null) {
    return null;
  }

  return {
    text: rawText,
    depth: normalizeDiscoverDepth(value.depth),
  };
};

const normalizeDiscoverInput = (input: unknown): ToolRegistryDiscoverInput => {
  const value = normalizeObjectInput(input);
  const queries = Array.isArray(value.queries)
    ? value.queries
        .map((entry) => normalizeDiscoverQueryInput(entry))
        .filter((entry): entry is ToolRegistryDiscoverQueryInput => entry !== null)
    : undefined;

  return {
    query: typeof value.query === "string" ? value.query : undefined,
    queries,
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
  interaction: "auto",
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

type NormalizedDiscoverQuery = {
  text: string;
  lowerText: string;
  depth: ToolRegistryDiscoverDepth;
};

const normalizeDiscoverQueries = (
  input: ToolRegistryDiscoverInput,
): Array<NormalizedDiscoverQuery> => {
  const normalized = (input.queries ?? []).map((query) => {
    const text = query.text.trim();
    return {
      text,
      lowerText: text.toLowerCase(),
      depth: normalizeDiscoverDepth(query.depth),
    };
  });

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackText = (input.query ?? "").trim();
  return [
    {
      text: fallbackText,
      lowerText: fallbackText.toLowerCase(),
      depth: 1,
    },
  ];
};

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

const tokenizeSearchQuery = (query: string): Array<string> =>
  Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[\s._:/-]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  );

const scoreDiscoverSummary = (
  summary: ToolRegistryToolSummary,
  query: NormalizedDiscoverQuery,
): number => {
  if (query.lowerText.length === 0) {
    return 1;
  }

  const lowerPath = summary.path.toLowerCase();
  const lowerSource = (summary.source ?? "").toLowerCase();
  const lowerDescription = (summary.description ?? "").toLowerCase();
  const lowerInputHint = (summary.inputHint ?? "").toLowerCase();
  const lowerOutputHint = (summary.outputHint ?? "").toLowerCase();

  if (lowerPath === query.lowerText) {
    return 100;
  }

  if (lowerPath.startsWith(query.lowerText)) {
    return 80;
  }

  if (lowerPath.includes(query.lowerText)) {
    return 60;
  }

  if (lowerSource.includes(query.lowerText)) {
    return 40;
  }

  if (lowerDescription.includes(query.lowerText)) {
    return 30;
  }

  if (query.depth >= 2) {
    if (
      lowerInputHint.includes(query.lowerText) ||
      lowerOutputHint.includes(query.lowerText)
    ) {
      return 20;
    }
  }

  if (query.depth === 0) {
    return 0;
  }

  const tokens = tokenizeSearchQuery(query.lowerText);
  if (tokens.length === 0) {
    return 0;
  }

  let pathMatches = 0;
  let sourceMatches = 0;
  let descriptionMatches = 0;
  let ioMatches = 0;

  for (const token of tokens) {
    if (lowerPath.includes(token)) {
      pathMatches += 1;
      continue;
    }

    if (lowerSource.includes(token)) {
      sourceMatches += 1;
      continue;
    }

    if (query.depth >= 2 && lowerDescription.includes(token)) {
      descriptionMatches += 1;
      continue;
    }

    if (
      query.depth >= 2 &&
      (lowerInputHint.includes(token) || lowerOutputHint.includes(token))
    ) {
      ioMatches += 1;
    }
  }

  const matchedTokens = pathMatches + sourceMatches + descriptionMatches + ioMatches;
  if (matchedTokens === 0) {
    return 0;
  }

  let score =
    pathMatches * 18 +
    sourceMatches * 12 +
    descriptionMatches * 8 +
    ioMatches * 6;

  score += matchedTokens === tokens.length ? 20 : 5;

  return score;
};

const dedupeSummariesByPath = (
  summaries: ReadonlyArray<ToolRegistryToolSummary>,
): Array<ToolRegistryToolSummary> => {
  const byPath = new Map<string, ToolRegistryToolSummary>();
  for (const summary of summaries) {
    if (!byPath.has(summary.path)) {
      byPath.set(summary.path, summary);
    }
  }

  return [...byPath.values()];
};

const inMemoryDiscover = (
  tools: InMemorySandboxToolMap,
  refHintTable: Record<string, string> | undefined,
  input: ToolRegistryDiscoverInput,
): ToolRegistryDiscoverOutput => {
  const limit = Math.max(1, Math.min(50, input.limit ?? 8));
  const includeSchemas = input.includeSchemas === true;
  const compact = input.compact === true;
  const queries = normalizeDiscoverQueries(input);
  const summaries = asStaticEntries(tools).map((entry) =>
    summarizeTool(
      entry.path,
      "in-memory",
      entry.description,
      entry.typing,
      includeSchemas,
      compact,
    ),
  );

  const perQuery = queries.map((query) => {
    const ranked = summaries
      .map((summary) => ({
        summary,
        score: scoreDiscoverSummary(summary, query),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.summary);

    return {
      text: query.text,
      depth: query.depth,
      bestPath: ranked[0]?.path ?? null,
      results: ranked,
      total: ranked.length,
    } satisfies ToolRegistryDiscoverQueryResult;
  });

  const primary = perQuery[0] ?? {
    text: "",
    depth: 1 as const,
    bestPath: null,
    results: [] as Array<ToolRegistryToolSummary>,
    total: 0,
  };
  const flattened = dedupeSummariesByPath(perQuery.flatMap((query) => query.results));

  return {
    bestPath: primary.bestPath,
    results: primary.results,
    total: primary.total,
    perQuery,
    refHintTable: selectRefHintTable(refHintTable, flattened, includeSchemas),
  };
};

const inMemoryCatalogNamespaces = (
  tools: InMemorySandboxToolMap,
  input: ToolRegistryCatalogNamespacesInput,
): ToolRegistryCatalogNamespacesOutput => {
  const limit = Math.max(1, Math.min(maxCatalogNamespacesLimit, input.limit ?? 50));
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
  const limit = Math.max(1, Math.min(maxCatalogToolsLimit, input.limit ?? 50));
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

    const interactionRequest: ToolInteractionRequest = {
      runId: input.runId,
      callId: input.callId,
      toolPath: input.toolPath,
      input: input.input,
      workspaceId: options.workspaceId,
      source: "in-memory",
      defaultMode: implementation.interaction ?? "auto",
    };

    return evaluateToolInteraction(interactionRequest, options.interactionPolicy).pipe(
      Effect.flatMap((decision) => {
        if (decision.kind !== "approved") {
          return Effect.succeed(toToolCallResultFromDecision(decision, interactionRequest));
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
      }),
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
  request: ToolRegistryCallInput,
  result: RuntimeToolCallResult,
): Effect.Effect<unknown, RuntimeAdapterError> => {
  if (result.ok) {
    return Effect.succeed(result.value);
  }

  if (result.kind === "pending") {
      return Effect.fail(
        new RuntimeAdapterError({
          operation: "call_tool_pending",
          runtimeKind: runtimeToolCallServiceRuntimeKind,
          message: result.error ?? `Tool call requires interaction resolution: ${request.toolPath}`,
          details: JSON.stringify({
            interactionId: result.interactionId,
            retryAfterMs: result.retryAfterMs,
            toolPath: request.toolPath,
          }),
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

export const invokeRuntimeToolCallResult = (
  toolRegistry: ToolRegistry,
  input: ToolRegistryCallInput,
): Effect.Effect<RuntimeToolCallResult, RuntimeAdapterError> => {
  if (input.toolPath === "discover") {
    return toolRegistry.discover(normalizeDiscoverInput(input.input)).pipe(
      Effect.map(
        (value): RuntimeToolCallResult => ({
          ok: true,
          value,
        }),
      ),
    );
  }

  if (input.toolPath === "catalog.namespaces") {
    return toolRegistry
      .catalogNamespaces(normalizeCatalogNamespacesInput(input.input))
      .pipe(
        Effect.map(
          (value): RuntimeToolCallResult => ({
            ok: true,
            value,
          }),
        ),
      );
  }

  if (input.toolPath === "catalog.tools") {
    return toolRegistry.catalogTools(normalizeCatalogToolsInput(input.input)).pipe(
      Effect.map(
        (value): RuntimeToolCallResult => ({
          ok: true,
          value,
        }),
      ),
    );
  }

  return toolRegistry.callTool(input);
};

export const createRuntimeToolCallService = (
  toolRegistry: ToolRegistry,
): RuntimeToolCallService => ({
  callTool: (input) =>
    invokeRuntimeToolCallResult(toolRegistry, input).pipe(
      Effect.flatMap((result) => {
        if (result.ok) {
          return Effect.succeed(result.value);
        }

        if (result.kind === "pending") {
          return Effect.fail(
            new RuntimeAdapterError({
              operation: "call_tool_pending",
              runtimeKind: runtimeToolCallServiceRuntimeKind,
              message: result.error
                ?? `Tool call requires interaction resolution: ${input.toolPath} [interactionId=${result.interactionId}]`,
              details: JSON.stringify({
                interactionId: result.interactionId,
                retryAfterMs: result.retryAfterMs,
                toolPath: input.toolPath,
              }),
            }),
          );
        }

        if (result.kind === "denied") {
          return Effect.fail(
            new RuntimeAdapterError({
              operation: "call_tool",
              runtimeKind: runtimeToolCallServiceRuntimeKind,
              message: result.error,
              details: `Tool call denied: ${input.toolPath}`,
            }),
          );
        }

        return Effect.fail(
          new RuntimeAdapterError({
            operation: "call_tool",
            runtimeKind: runtimeToolCallServiceRuntimeKind,
            message: result.error,
            details: `Tool call failed: ${input.toolPath}`,
          }),
        );
      }),
    ),
});
