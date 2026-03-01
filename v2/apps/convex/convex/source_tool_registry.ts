import {
  PersistentToolApprovalPolicyStoreError,
  RuntimeAdapterError,
  ToolProviderError,
  createPersistentToolApprovalPolicy,
  makeOpenApiToolProvider,
  makeToolProviderRegistry,
  type PersistentToolApprovalRecord,
  type PersistentToolApprovalStore,
  type ToolApprovalPolicy,
  type ToolRegistry,
  type ToolRegistryCatalogNamespacesInput,
  type ToolRegistryCatalogNamespacesOutput,
  type ToolRegistryCatalogToolsInput,
  type ToolRegistryCatalogToolsOutput,
  type ToolRegistryDiscoverInput,
  type ToolRegistryDiscoverOutput,
  type ToolRegistryToolSummary,
} from "@executor-v2/engine";
import {
  ApprovalSchema,
  OpenApiInvocationPayloadSchema,
  type Approval,
  type CanonicalToolDescriptor,
  type Source,
} from "@executor-v2/schema";
import type { RuntimeToolCallResult } from "@executor-v2/sdk";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { internal } from "./_generated/api";
import { internalMutation, type ActionCtx } from "./_generated/server";

const runtimeInternal = internal as any;

const decodeApproval = Schema.decodeUnknownSync(ApprovalSchema);
const decodeOpenApiInvocationPayload = Schema.decodeUnknownSync(OpenApiInvocationPayloadSchema);

const sourceToolRegistryRuntimeKind = "source-tool-registry";
const defaultPendingRetryAfterMs = 1_000;
const maxCatalogNamespacesLimit = 5_000;
const maxCatalogToolsLimit = 50_000;
const maxUnknownToolSuggestions = 3;

const readBooleanFlag = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const requireToolApprovalsByDefault = readBooleanFlag(
  process.env.CONVEX_REQUIRE_TOOL_APPROVALS,
);

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toRuntimeAdapterError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    operation,
    runtimeKind: sourceToolRegistryRuntimeKind,
    message,
    details,
  });

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

const toToolCallResultFromDecision = (
  decision:
    | { kind: "approved" }
    | { kind: "pending"; approvalId: string; retryAfterMs?: number; error?: string }
    | { kind: "denied"; error: string },
  toolPath: string,
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
      approvalId: decision.approvalId,
      retryAfterMs: normalizePendingRetryAfterMs(decision.retryAfterMs),
      error: decision.error,
    };
  }

  return {
    ok: false,
    kind: "denied",
    error: normalizeDeniedError(decision.error, toolPath),
  };
};

const serializeInputPreview = (input: Record<string, unknown> | undefined): string => {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
};

const toPersistentApprovalStoreError = (
  operation: string,
  message: string,
  details: string | null,
): PersistentToolApprovalPolicyStoreError =>
  new PersistentToolApprovalPolicyStoreError({
    operation,
    message,
    details,
  });

const toPersistentApprovalRecord = (
  approval: Approval,
): PersistentToolApprovalRecord => ({
  approvalId: approval.id,
  workspaceId: approval.workspaceId,
  runId: approval.taskRunId,
  callId: approval.callId,
  toolPath: approval.toolPath,
  status: approval.status,
  reason: approval.reason,
});

const normalizeToolPathForLookup = (path: string): string =>
  path
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const jsonObjectFromUnknown = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const normalizeHeaderString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseSourceConfig = (source: Source): Record<string, unknown> =>
  jsonObjectFromUnknown(safeJsonParse(source.configJson));

const collectConfiguredHeadersFromSourceConfig = (
  config: Record<string, unknown>,
): Record<string, string> => {
  const headers = jsonObjectFromUnknown(config.headers);
  const nextHeaders: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = normalizeHeaderString(rawKey);
    const value = normalizeHeaderString(rawValue);
    if (key && value) {
      nextHeaders[key] = value;
    }
  }

  return nextHeaders;
};

const collectAuthHeadersFromSourceConfig = (
  config: Record<string, unknown>,
): Record<string, string> => {
  const auth = jsonObjectFromUnknown(config.auth);
  const authType = normalizeHeaderString(auth.type)?.toLowerCase();
  const nextHeaders: Record<string, string> = {};

  if (authType === "bearer") {
    const token = normalizeHeaderString(auth.token) ?? normalizeHeaderString(auth.value);
    if (token) {
      nextHeaders.Authorization = `Bearer ${token}`;
    }
  }

  if (authType === "apikey" || authType === "api_key") {
    const token = normalizeHeaderString(auth.value) ?? normalizeHeaderString(auth.token);
    if (token) {
      const headerName = normalizeHeaderString(auth.header) ?? "Authorization";
      nextHeaders[headerName] = token;
    }
  }

  if (authType === "basic") {
    const username = normalizeHeaderString(auth.username);
    const password = normalizeHeaderString(auth.password);
    if (username && password && typeof btoa === "function") {
      nextHeaders.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
    }
  }

  return nextHeaders;
};

const mergeHeaders = (...sets: ReadonlyArray<Record<string, string>>): Record<string, string> => {
  const merged: Record<string, string> = {};
  const keyByLower = new Map<string, string>();

  for (const headers of sets) {
    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (key.length === 0 || value.length === 0) {
        continue;
      }

      const normalizedKey = key.toLowerCase();
      const existingKey = keyByLower.get(normalizedKey);
      if (existingKey && existingKey !== key) {
        delete merged[existingKey];
      }

      keyByLower.set(normalizedKey, key);
      merged[key] = value;
    }
  }

  return merged;
};

const resolveSourceCredentialHeadersForInvocation = async (
  ctx: ActionCtx,
  source: Source,
): Promise<Record<string, string>> => {
  try {
    const resolved = (await ctx.runAction(
      runtimeInternal.control_plane.credentials.resolveSourceCredentialHeadersForIngest,
      {
        workspaceId: source.workspaceId,
        sourceId: source.id,
        sourceName: source.name,
        sourceEndpoint: source.endpoint,
      },
    )) as { headers?: unknown };

    const headers = jsonObjectFromUnknown(resolved.headers);
    const normalized: Record<string, string> = {};

    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const key = normalizeHeaderString(rawKey);
      const value = normalizeHeaderString(rawValue);
      if (key && value) {
        normalized[key] = value;
      }
    }

    return normalized;
  } catch {
    return {};
  }
};

const resolveSourceHeadersForInvocation = async (
  ctx: ActionCtx,
  source: Source,
): Promise<Record<string, string>> => {
  const config = parseSourceConfig(source);

  return mergeHeaders(
    collectConfiguredHeadersFromSourceConfig(config),
    collectAuthHeadersFromSourceConfig(config),
    await resolveSourceCredentialHeadersForInvocation(ctx, source),
  );
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const GraphqlInvocationArgSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  required: Schema.Boolean,
  type: Schema.String,
  defaultValue: Schema.NullOr(Schema.String),
});

const GraphqlRawInvocationSchema = Schema.Struct({
  kind: Schema.Literal("graphql_raw"),
  endpoint: Schema.String,
});

const GraphqlFieldInvocationSchema = Schema.Struct({
  kind: Schema.Literal("graphql_field"),
  endpoint: Schema.String,
  operationType: Schema.Literal("query", "mutation"),
  fieldName: Schema.String,
  args: Schema.Array(GraphqlInvocationArgSchema),
});

const GraphqlInvocationPayloadSchema = Schema.Union(
  GraphqlRawInvocationSchema,
  GraphqlFieldInvocationSchema,
);

type GraphqlInvocationPayload = typeof GraphqlInvocationPayloadSchema.Type;

const decodeGraphqlInvocationPayload = Schema.decodeUnknownSync(GraphqlInvocationPayloadSchema);

const McpInvocationPayloadSchema = Schema.Struct({
  kind: Schema.Literal("mcp_tool"),
  endpoint: Schema.String,
  transport: Schema.Literal("streamable-http", "sse"),
  queryParams: Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
  toolName: Schema.String,
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
});

type McpInvocationPayload = typeof McpInvocationPayloadSchema.Type;

const decodeMcpInvocationPayload = Schema.decodeUnknownSync(McpInvocationPayloadSchema);

const asOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const normalizeInvokeInput = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
};

const createGraphqlOperationQuery = (
  payload: Extract<GraphqlInvocationPayload, { kind: "graphql_field" }>,
  args: Record<string, unknown>,
): {
  query: string;
  variables: Record<string, unknown>;
} => {
  const definitions: Array<string> = [];
  const callArgs: Array<string> = [];
  const variables: Record<string, unknown> = {};

  for (const arg of payload.args) {
    const value = args[arg.name];

    if (value === undefined || value === null) {
      if (arg.required) {
        throw new Error(`Missing required GraphQL argument: ${arg.name}`);
      }

      continue;
    }

    const varType = arg.type.trim().length > 0 ? arg.type : "String";
    definitions.push(`$${arg.name}: ${varType}`);
    callArgs.push(`${arg.name}: $${arg.name}`);
    variables[arg.name] = value;
  }

  const variableDefs = definitions.length > 0 ? `(${definitions.join(", ")})` : "";
  const fieldArgs = callArgs.length > 0 ? `(${callArgs.join(", ")})` : "";
  const selectionSet = asOptionalString(args.selectionSet);
  const fieldSelection =
    selectionSet && selectionSet.length > 0
      ? `${payload.fieldName}${fieldArgs} { ${selectionSet} }`
      : `${payload.fieldName}${fieldArgs}`;
  const query = `${payload.operationType}${variableDefs} { ${fieldSelection} }`;

  return { query, variables };
};

const graphqlResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
};

const createMcpEndpointUrl = (payload: McpInvocationPayload): URL => {
  const url = new URL(payload.endpoint);

  for (const [key, value] of Object.entries(payload.queryParams)) {
    url.searchParams.set(key, value);
  }

  return url;
};

const postMcpJsonRpc = async (
  endpoint: URL,
  body: unknown,
  sessionId: string | null,
  sourceHeaders: Record<string, string>,
): Promise<Response> => {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  for (const [key, value] of Object.entries(sourceHeaders)) {
    headers.set(key, value);
  }

  if (sessionId && sessionId.trim().length > 0) {
    headers.set("mcp-session-id", sessionId);
  }

  return await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

const decodeMcpJsonResponse = async (response: Response): Promise<Record<string, unknown>> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!contentType.includes("application/json")) {
    const text = await response.text();
    return { raw: text };
  }

  return jsonObjectFromUnknown(await response.json());
};

const describeOutput = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const deriveHintFromSchemaJson = (
  schemaJson: string | null | undefined,
  fallback: string,
): string => {
  if (!schemaJson) {
    return fallback;
  }

  const schema = safeJsonParse(schemaJson);
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
        return keys.length <= 3 ? `object { ${shown} }` : `object { ${shown}, ... }`;
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

type WorkspaceToolIndexRow = {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  artifactId: string;
  toolId: string;
  protocol: string;
  namespace: string;
  path: string;
  pathLower: string;
  normalizedPath: string;
  name: string;
  description: string | null;
  operationHash: string;
  approvalMode: string;
  status: string;
  refHintTableJson?: string | null;
};

type ArtifactToolRow = {
  artifactId: string;
  protocol: string;
  toolId: string;
  name: string;
  description: string | null;
  canonicalPath: string;
  operationHash: string;
  invocationJson: string;
  inputSchemaJson?: string | null;
  outputSchemaJson?: string | null;
  metadataJson?: string | null;
};

const toToolProviderDetails = (cause: unknown): string =>
  ParseResult.isParseError(cause)
    ? ParseResult.TreeFormatter.formatErrorSync(cause)
    : String(cause);

const toToolProviderError = (
  providerKind: "openapi" | "graphql" | "mcp",
  operation: string,
  message: string,
  cause: unknown,
): ToolProviderError =>
  new ToolProviderError({
    providerKind,
    operation,
    message,
    details: toToolProviderDetails(cause),
  });

const scoreSummary = (summary: ToolRegistryToolSummary, query: string): number => {
  if (query.length === 0) {
    return 1;
  }

  const lowerQuery = query.toLowerCase();
  const lowerPath = summary.path.toLowerCase();
  const lowerSource = (summary.source ?? "").toLowerCase();
  const lowerDescription = (summary.description ?? "").toLowerCase();

  if (lowerPath === lowerQuery) {
    return 100;
  }

  if (lowerPath.startsWith(lowerQuery)) {
    return 80;
  }

  if (lowerPath.includes(lowerQuery)) {
    return 60;
  }

  if (lowerSource.includes(lowerQuery)) {
    return 40;
  }

  if (lowerDescription.includes(lowerQuery)) {
    return 30;
  }

  return 0;
};

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);

  for (let column = 0; column <= right.length; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;

    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitutionCost,
      );
    }

    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }

  return previous[right.length] ?? right.length;
};

const uniquePaths = (paths: ReadonlyArray<string>): Array<string> => {
  const seen = new Set<string>();
  const ordered: Array<string> = [];

  for (const path of paths) {
    if (!seen.has(path)) {
      seen.add(path);
      ordered.push(path);
    }

    if (ordered.length >= maxUnknownToolSuggestions) {
      break;
    }
  }

  return ordered;
};

const toToolSummary = (
  row: WorkspaceToolIndexRow,
  options: {
    includeSchemas: boolean;
    compact: boolean;
    artifactTool?: ArtifactToolRow | null;
  },
): ToolRegistryToolSummary => {
  const inputSchemaJson = options.artifactTool?.inputSchemaJson ?? undefined;
  const outputSchemaJson = options.artifactTool?.outputSchemaJson ?? undefined;

  return {
    path: row.path,
    source: row.sourceName,
    approval: row.approvalMode === "required" ? "required" : "auto",
    description: options.compact ? undefined : row.description ?? undefined,
    inputHint: options.compact
      ? undefined
      : options.artifactTool
        ? deriveHintFromSchemaJson(inputSchemaJson ?? null, "input")
        : undefined,
    outputHint: options.compact
      ? undefined
      : options.artifactTool
        ? deriveHintFromSchemaJson(outputSchemaJson ?? null, "output")
        : undefined,
    typing:
      options.includeSchemas && (inputSchemaJson || outputSchemaJson)
        ? {
            inputSchemaJson,
            outputSchemaJson,
            refHintKeys: [],
          }
        : undefined,
  };
};

const toSearchScoringSummary = (row: WorkspaceToolIndexRow): ToolRegistryToolSummary => ({
  path: row.path,
  source: row.sourceName,
  approval: row.approvalMode === "required" ? "required" : "auto",
  description: row.description ?? undefined,
});

const hydrateRowsWithArtifactTools = (
  ctx: ActionCtx,
  rows: ReadonlyArray<WorkspaceToolIndexRow>,
): Effect.Effect<Array<{ row: WorkspaceToolIndexRow; artifactTool: ArtifactToolRow | null }>, RuntimeAdapterError> =>
  Effect.forEach(
    rows,
    (row) =>
      getArtifactToolEffect(ctx, row.artifactId, row.toolId).pipe(
        Effect.map((artifactTool) => ({
          row,
          artifactTool,
        })),
      ),
    { concurrency: 8 },
  );

const parseRefHintTableJson = (value: string | null | undefined): Record<string, string> | null => {
  if (!value) {
    return null;
  }

  const parsed = safeJsonParse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw === "string") {
      next[key] = raw;
    }
  }

  return Object.keys(next).length > 0 ? next : null;
};

const mergeRefHintTables = (
  rows: ReadonlyArray<WorkspaceToolIndexRow>,
  includeSchemas: boolean,
): Record<string, string> | undefined => {
  if (!includeSchemas) {
    return undefined;
  }

  const merged: Record<string, string> = {};
  for (const row of rows) {
    const table = parseRefHintTableJson(row.refHintTableJson ?? null);
    if (!table) {
      continue;
    }

    Object.assign(merged, table);
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
};

const listWorkspaceToolsEffect = (
  ctx: ActionCtx,
  workspaceId: string,
  options: {
    limit: number;
    sourceId?: string;
    namespace?: string;
  },
): Effect.Effect<Array<WorkspaceToolIndexRow>, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () =>
      (await ctx.runQuery(runtimeInternal.control_plane.tool_registry.listWorkspaceTools, {
        workspaceId,
        limit: options.limit,
        sourceId: options.sourceId,
        namespace: options.namespace,
        includeDisabled: false,
      })) as Array<WorkspaceToolIndexRow>,
    catch: (cause) =>
      toRuntimeAdapterError(
        "list_workspace_tools",
        "Failed to list indexed workspace tools",
        String(cause),
      ),
  });

const searchWorkspaceToolsEffect = (
  ctx: ActionCtx,
  workspaceId: string,
  options: {
    query: string;
    limit: number;
    sourceId?: string;
    namespace?: string;
  },
): Effect.Effect<Array<WorkspaceToolIndexRow>, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () =>
      (await ctx.runQuery(runtimeInternal.control_plane.tool_registry.searchWorkspaceTools, {
        workspaceId,
        query: options.query,
        limit: options.limit,
        sourceId: options.sourceId,
        namespace: options.namespace,
        includeDisabled: false,
      })) as Array<WorkspaceToolIndexRow>,
    catch: (cause) =>
      toRuntimeAdapterError(
        "search_workspace_tools",
        "Failed to search indexed workspace tools",
        String(cause),
      ),
  });

const getWorkspaceToolByPathEffect = (
  ctx: ActionCtx,
  workspaceId: string,
  toolPath: string,
): Effect.Effect<WorkspaceToolIndexRow | null, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () =>
      (await ctx.runQuery(runtimeInternal.control_plane.tool_registry.getWorkspaceToolByPath, {
        workspaceId,
        pathLower: toolPath.toLowerCase(),
      })) as WorkspaceToolIndexRow | null,
    catch: (cause) =>
      toRuntimeAdapterError(
        "resolve_tool_path",
        "Failed to resolve tool path",
        String(cause),
      ),
  });

const listWorkspaceToolsByNormalizedPathEffect = (
  ctx: ActionCtx,
  workspaceId: string,
  normalizedPath: string,
): Effect.Effect<Array<WorkspaceToolIndexRow>, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () =>
      (await ctx.runQuery(runtimeInternal.control_plane.tool_registry.listWorkspaceToolsByNormalizedPath, {
        workspaceId,
        normalizedPath,
        limit: 25,
      })) as Array<WorkspaceToolIndexRow>,
    catch: (cause) =>
      toRuntimeAdapterError(
        "resolve_tool_path",
        "Failed to resolve normalized tool path",
        String(cause),
      ),
  });

const getArtifactToolEffect = (
  ctx: ActionCtx,
  artifactId: string,
  toolId: string,
): Effect.Effect<ArtifactToolRow | null, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () =>
      (await ctx.runQuery(runtimeInternal.control_plane.tool_registry.getArtifactTool, {
        artifactId,
        toolId,
      })) as ArtifactToolRow | null,
    catch: (cause) =>
      toRuntimeAdapterError(
        "load_artifact_tool",
        `Failed to load artifact tool: ${artifactId}:${toolId}`,
        String(cause),
      ),
  });

const getSourceForInvocationEffect = (
  ctx: ActionCtx,
  workspaceId: string,
  sourceId: string,
): Effect.Effect<Source | null, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () => {
      const source = (await ctx.runQuery(runtimeInternal.control_plane.sources.getSourceForIngest, {
        sourceId,
      })) as Source | null;

      if (!source || source.workspaceId !== workspaceId || !source.enabled) {
        return null;
      }

      return source;
    },
    catch: (cause) =>
      toRuntimeAdapterError(
        "load_source",
        `Failed to load source for invocation: ${sourceId}`,
        String(cause),
      ),
  });

const invokeToolWithRegistry = (
  ctx: ActionCtx,
  source: Source,
  artifactTool: ArtifactToolRow,
  args: Record<string, unknown>,
): Effect.Effect<{ output: unknown; isError: boolean }, RuntimeAdapterError> =>
  Effect.gen(function* () {
    const openApiProvider = makeOpenApiToolProvider();

    const graphqlProvider = {
      kind: "graphql" as const,
      invoke: (input: { source: Source | null; tool: CanonicalToolDescriptor; args: unknown }) =>
        Effect.tryPromise({
          try: async () => {
            if (!input.source) {
              throw new Error("GraphQL provider requires a source");
            }

            const payload = decodeGraphqlInvocationPayload(input.tool.providerPayload);
            const invokeArgs = normalizeInvokeInput(input.args);

            let query: string;
            let variables: Record<string, unknown> | undefined;
            let operationName: string | undefined;

            if (payload.kind === "graphql_raw") {
              const rawQuery = asOptionalString(invokeArgs.query);
              if (!rawQuery) {
                throw new Error("Missing required GraphQL query string at args.query");
              }

              query = rawQuery;
              variables = jsonObjectFromUnknown(invokeArgs.variables);
              operationName = asOptionalString(invokeArgs.operationName) ?? undefined;
            } else {
              const built = createGraphqlOperationQuery(payload, invokeArgs);
              query = built.query;
              variables = built.variables;
              operationName = payload.fieldName;
            }

            const sourceHeaders = await resolveSourceHeadersForInvocation(ctx, input.source);

            const response = await fetch(payload.endpoint, {
              method: "POST",
              headers: mergeHeaders(
                {
                  "content-type": "application/json",
                },
                sourceHeaders,
              ),
              body: JSON.stringify({
                query,
                variables,
                operationName,
              }),
            });

            const body = await graphqlResponseBody(response);
            const bodyRecord = jsonObjectFromUnknown(body);
            const hasErrors = Array.isArray(bodyRecord.errors);

            return {
              output: {
                status: response.status,
                headers: headersToRecord(response.headers),
                body,
              },
              isError: response.status >= 400 || hasErrors,
            };
          },
          catch: (cause) =>
            toToolProviderError(
              "graphql",
              "invoke_tool",
              `GraphQL invocation failed for tool: ${input.tool.toolId}`,
              cause,
            ),
        }),
    };

    const mcpProvider = {
      kind: "mcp" as const,
      invoke: (input: { source: Source | null; tool: CanonicalToolDescriptor; args: unknown }) =>
        Effect.tryPromise({
          try: async () => {
            if (!input.source) {
              throw new Error("MCP provider requires a source");
            }

            const payload = decodeMcpInvocationPayload(input.tool.providerPayload);
            const invokeArgs = normalizeInvokeInput(input.args);
            const sourceHeaders = await resolveSourceHeadersForInvocation(ctx, input.source);

            if (payload.transport !== "streamable-http") {
              throw new Error(
                `Unsupported MCP transport for runtime invocation: ${payload.transport}`,
              );
            }

            const endpoint = createMcpEndpointUrl(payload);
            const initializeResponse = await postMcpJsonRpc(
              endpoint,
              {
                jsonrpc: "2.0",
                id: `init_${crypto.randomUUID()}`,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: {
                    name: "executor-v2-runtime",
                    version: "0.1.0",
                  },
                },
              },
              null,
              sourceHeaders,
            );
            const initializeBody = await decodeMcpJsonResponse(initializeResponse);

            const sessionId = initializeResponse.headers.get("mcp-session-id");

            if (initializeResponse.status >= 400 || initializeBody.error !== undefined) {
              return {
                output: {
                  status: initializeResponse.status,
                  headers: headersToRecord(initializeResponse.headers),
                  body: initializeBody,
                },
                isError: true,
              };
            }

            await postMcpJsonRpc(
              endpoint,
              {
                jsonrpc: "2.0",
                method: "notifications/initialized",
                params: {},
              },
              sessionId,
              sourceHeaders,
            );

            const callResponse = await postMcpJsonRpc(
              endpoint,
              {
                jsonrpc: "2.0",
                id: `call_${crypto.randomUUID()}`,
                method: "tools/call",
                params: {
                  name: payload.toolName,
                  arguments: invokeArgs,
                },
              },
              sessionId,
              sourceHeaders,
            );
            const callBody = await decodeMcpJsonResponse(callResponse);

            return {
              output: {
                status: callResponse.status,
                headers: headersToRecord(callResponse.headers),
                body: callBody,
              },
              isError: callResponse.status >= 400 || callBody.error !== undefined,
            };
          },
          catch: (cause) =>
            toToolProviderError(
              "mcp",
              "invoke_tool",
              `MCP invocation failed for tool: ${input.tool.toolId}`,
              cause,
            ),
        }),
    };

    const registry = makeToolProviderRegistry([
      {
        kind: "openapi",
        invoke: (input) => openApiProvider.invoke(input),
      },
      graphqlProvider,
      mcpProvider,
    ]);

    const providerKind = artifactTool.protocol;
    const invocationPayload = safeJsonParse(artifactTool.invocationJson);

    const descriptor: CanonicalToolDescriptor = {
      providerKind: providerKind as any,
      sourceId: source.id,
      workspaceId: source.workspaceId,
      toolId: artifactTool.toolId,
      name: artifactTool.name,
      description: artifactTool.description,
      invocationMode:
        providerKind === "graphql"
          ? "graphql"
          : providerKind === "mcp"
            ? "mcp"
            : "http",
      availability: "remote_capable",
      providerPayload:
        providerKind === "openapi"
          ? decodeOpenApiInvocationPayload(invocationPayload)
          : providerKind === "graphql"
            ? decodeGraphqlInvocationPayload(invocationPayload)
            : decodeMcpInvocationPayload(invocationPayload),
    };

    const invocation = yield* registry
      .invoke({
        source,
        tool: descriptor,
        args,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ToolProviderError"
            ? toRuntimeAdapterError("invoke_tool", cause.message, cause.details)
            : toRuntimeAdapterError("invoke_tool", cause.message, null),
        ),
      );

    return invocation;
  });

const unknownToolPathErrorMessage = (
  requestedPath: string,
  suggestions: ReadonlyArray<string>,
): string => {
  const hintQuery = requestedPath.trim().length > 0 ? requestedPath.trim() : "tool";
  const suggestionText =
    suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}.` : "";

  return `Unknown tool path: ${requestedPath}.${suggestionText} Use tools.discover({ query: ${JSON.stringify(
    hintQuery,
  )} }) or tools.catalog.tools({ query: ${JSON.stringify(hintQuery)} }) to find available tool paths.`;
};

const resolveToolPath = (
  ctx: ActionCtx,
  workspaceId: string,
  requestedPath: string,
): Effect.Effect<
  { row: WorkspaceToolIndexRow | null; suggestions: Array<string> },
  RuntimeAdapterError
> =>
  Effect.gen(function* () {
    const trimmedPath = requestedPath.trim();
    if (trimmedPath.length === 0) {
      return {
        row: null,
        suggestions: [],
      };
    }

    const exact = yield* getWorkspaceToolByPathEffect(ctx, workspaceId, trimmedPath);
    if (exact && exact.status === "active") {
      return {
        row: exact,
        suggestions: [],
      };
    }

    const normalizedPath = normalizeToolPathForLookup(trimmedPath);
    const normalizedMatches = yield* listWorkspaceToolsByNormalizedPathEffect(
      ctx,
      workspaceId,
      normalizedPath,
    );

    if (normalizedMatches.length === 1) {
      return {
        row: normalizedMatches[0] ?? null,
        suggestions: [],
      };
    }

    if (normalizedMatches.length > 1) {
      const preferred = [...normalizedMatches].sort((left, right) => {
        if (left.path.length !== right.path.length) {
          return left.path.length - right.path.length;
        }

        return left.path.localeCompare(right.path);
      })[0];

      return {
        row: preferred ?? null,
        suggestions: [],
      };
    }

    const candidates = yield* searchWorkspaceToolsEffect(ctx, workspaceId, {
      query: trimmedPath,
      limit: 20,
    });

    if (candidates.length === 0) {
      return {
        row: null,
        suggestions: [],
      };
    }

    const lowerRequested = trimmedPath.toLowerCase();
    const closest = [...candidates]
      .map((candidate) => ({
        candidate,
        distance: levenshteinDistance(candidate.path.toLowerCase(), lowerRequested),
      }))
      .sort((left, right) => {
        if (left.distance !== right.distance) {
          return left.distance - right.distance;
        }

        return left.candidate.path.localeCompare(right.candidate.path);
      });

    const best = closest[0];
    const maxDistance = Math.max(2, Math.floor(trimmedPath.length * 0.2));

    if (best && best.distance <= maxDistance) {
      return {
        row: best.candidate,
        suggestions: [],
      };
    }

    return {
      row: null,
      suggestions: uniquePaths(closest.map((item) => item.candidate.path)),
    };
  });

const approvalModeValidator = v.union(v.literal("auto"), v.literal("required"));

export const evaluateToolApproval = internalMutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    inputPreviewJson: v.string(),
    defaultMode: approvalModeValidator,
    requireApprovals: v.optional(v.boolean()),
    retryAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const taskRunRow = await ctx.db
      .query("taskRuns")
      .withIndex("by_domainId", (q) => q.eq("id", args.runId))
      .unique();

    if (!taskRunRow || taskRunRow.workspaceId !== args.workspaceId) {
      return {
        kind: "denied" as const,
        error: `Unknown run for approval request: ${args.runId}`,
      };
    }

    const store: PersistentToolApprovalStore = {
      findByRunAndCall: (input) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await ctx.db
              .query("approvals")
              .withIndex("by_taskRunId_callId", (q) =>
                q.eq("taskRunId", input.runId).eq("callId", input.callId),
              )
              .collect();

            const row = rows.find((candidate) => candidate.workspaceId === input.workspaceId) ?? null;
            if (!row) {
              return null;
            }

            const approval = decodeApproval(
              stripConvexSystemFields(row as unknown as Record<string, unknown>),
            );

            return toPersistentApprovalRecord(approval);
          },
          catch: (cause) =>
            toPersistentApprovalStoreError(
              "approvals.find",
              "Failed to query approval",
              String(cause),
            ),
        }),

      createPending: (input) =>
        Effect.tryPromise({
          try: async () => {
            const existingRows = await ctx.db
              .query("approvals")
              .withIndex("by_taskRunId_callId", (q) =>
                q.eq("taskRunId", input.runId).eq("callId", input.callId),
              )
              .collect();

            const existingRow =
              existingRows.find((candidate) => candidate.workspaceId === input.workspaceId) ?? null;
            if (existingRow) {
              return toPersistentApprovalRecord(
                decodeApproval(
                  stripConvexSystemFields(existingRow as unknown as Record<string, unknown>),
                ),
              );
            }

            const approval = {
              id: `apr_${crypto.randomUUID()}`,
              workspaceId: input.workspaceId,
              taskRunId: input.runId,
              callId: input.callId,
              toolPath: input.toolPath,
              status: "pending",
              inputPreviewJson: input.inputPreviewJson,
              reason: null,
              requestedAt: Date.now(),
              resolvedAt: null,
            } as Approval;

            await ctx.db.insert("approvals", approval);
            return toPersistentApprovalRecord(approval);
          },
          catch: (cause) =>
            toPersistentApprovalStoreError(
              "approvals.create",
              "Failed to create pending approval",
              String(cause),
            ),
        }),
    };

    const policy = createPersistentToolApprovalPolicy({
      store,
      requireApprovals: args.requireApprovals === true,
      retryAfterMs: args.retryAfterMs,
      serializeInputPreview: () => args.inputPreviewJson,
      onStoreError: (error) => ({
        kind: "denied",
        error:
          error.details && error.details.length > 0
            ? `${error.message}: ${error.details}`
            : error.message,
      }),
    });

    return await policy.evaluate({
      workspaceId: args.workspaceId,
      runId: args.runId,
      callId: args.callId,
      toolPath: args.toolPath,
      defaultMode: args.defaultMode,
    });
  },
});

const createConvexPersistentToolApprovalPolicy = (
  ctx: ActionCtx,
  workspaceId: string,
  options: {
    requireApprovals: boolean;
    retryAfterMs: number;
  },
): ToolApprovalPolicy => ({
  evaluate: (input) =>
    ctx.runMutation(runtimeInternal.source_tool_registry.evaluateToolApproval, {
      workspaceId,
      runId: input.runId,
      callId: input.callId,
      toolPath: input.toolPath,
      inputPreviewJson: serializeInputPreview(input.input),
      defaultMode: input.defaultMode,
      requireApprovals: options.requireApprovals,
      retryAfterMs: options.retryAfterMs,
    }),
});

const evaluateApprovalDecisionEffect = (
  policy: ToolApprovalPolicy,
  input: {
    workspaceId: string;
    runId: string;
    callId: string;
    toolPath: string;
    source: string;
    defaultMode: "auto" | "required";
    args: Record<string, unknown>;
  },
): Effect.Effect<
  | { kind: "approved" }
  | { kind: "pending"; approvalId: string; retryAfterMs?: number; error?: string }
  | { kind: "denied"; error: string },
  RuntimeAdapterError
> =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(
        policy.evaluate({
          workspaceId: input.workspaceId,
          runId: input.runId,
          callId: input.callId,
          toolPath: input.toolPath,
          source: input.source,
          input: input.args,
          defaultMode: input.defaultMode,
        }),
      ),
    catch: (cause) =>
      toRuntimeAdapterError(
        "evaluate_approval",
        `Tool approval evaluation failed: ${input.toolPath}`,
        String(cause),
      ),
  });

const describeSource = (row: {
  sourceName: string;
  sourceKind: string;
}): string => `${row.sourceKind.toUpperCase()} source: ${row.sourceName}`;

export type ConvexSourceToolRegistryOptions = {
  requireToolApprovals?: boolean;
  approvalRetryAfterMs?: number;
};

export const createConvexSourceToolRegistry = (
  ctx: ActionCtx,
  workspaceId: string,
  options: ConvexSourceToolRegistryOptions = {},
): ToolRegistry => {
  const requireApprovals = options.requireToolApprovals ?? requireToolApprovalsByDefault;
  const approvalRetryAfterMs =
    typeof options.approvalRetryAfterMs === "number" &&
    Number.isFinite(options.approvalRetryAfterMs) &&
    options.approvalRetryAfterMs >= 0
      ? Math.round(options.approvalRetryAfterMs)
      : defaultPendingRetryAfterMs;

  const approvalPolicy = createConvexPersistentToolApprovalPolicy(ctx, workspaceId, {
    requireApprovals,
    retryAfterMs: approvalRetryAfterMs,
  });

  return {
    callTool: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveToolPath(ctx, workspaceId, input.toolPath);
        if (!resolved.row) {
          return {
            ok: false,
            kind: "failed",
            error: unknownToolPathErrorMessage(input.toolPath, resolved.suggestions),
          } satisfies RuntimeToolCallResult;
        }

        const args = normalizeInvokeInput(input.input);
        const toolPath = resolved.row.path;
        const approval = yield* evaluateApprovalDecisionEffect(approvalPolicy, {
          workspaceId,
          runId: input.runId,
          callId: input.callId,
          toolPath,
          source: resolved.row.sourceName,
          defaultMode:
            resolved.row.approvalMode === "required"
              ? "required"
              : "auto",
          args,
        });

        if (approval.kind !== "approved") {
          return toToolCallResultFromDecision(approval, toolPath);
        }

        const artifactTool = yield* getArtifactToolEffect(
          ctx,
          resolved.row.artifactId,
          resolved.row.toolId,
        );

        if (!artifactTool) {
          return {
            ok: false,
            kind: "failed",
            error: `Missing artifact tool payload for ${resolved.row.path}`,
          } satisfies RuntimeToolCallResult;
        }

        const source = yield* getSourceForInvocationEffect(ctx, workspaceId, resolved.row.sourceId);
        if (!source) {
          return {
            ok: false,
            kind: "failed",
            error: `Source unavailable for tool: ${resolved.row.path}`,
          } satisfies RuntimeToolCallResult;
        }

        const invocation = yield* invokeToolWithRegistry(ctx, source, artifactTool, args);
        if (invocation.isError) {
          return {
            ok: false,
            kind: "failed",
            error: describeOutput(invocation.output),
          } satisfies RuntimeToolCallResult;
        }

        return {
          ok: true,
          value: invocation.output,
        } satisfies RuntimeToolCallResult;
      }),

    discover: (input: ToolRegistryDiscoverInput) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(50, input.limit ?? 8));
        const queryText = (input.query ?? "").trim();
        const compact = input.compact === true;
        const includeSchemas = input.includeSchemas === true;
        const fetchLimit = Math.max(limit * 6, 50);

        const rows =
          queryText.length > 0
            ? yield* searchWorkspaceToolsEffect(ctx, workspaceId, {
                query: queryText,
                limit: fetchLimit,
              })
            : yield* listWorkspaceToolsEffect(ctx, workspaceId, {
                limit: fetchLimit,
              });

        const rankedRows = rows
          .map((row) => ({
            row,
            score: scoreSummary(toSearchScoringSummary(row), queryText.toLowerCase()),
          }))
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);

        const selectedRows = rankedRows.map((item) => item.row);

        const summaries = includeSchemas
          ? (
              yield* hydrateRowsWithArtifactTools(ctx, selectedRows).pipe(
                Effect.map((entries) =>
                  entries.map(({ row, artifactTool }) =>
                    toToolSummary(row, {
                      includeSchemas,
                      compact,
                      artifactTool,
                    }),
                  ),
                ),
              )
            )
          : selectedRows.map((row) =>
              toToolSummary(row, {
                includeSchemas,
                compact,
              }),
            );

        return {
          bestPath: summaries[0]?.path ?? null,
          results: summaries,
          total: summaries.length,
          refHintTable: mergeRefHintTables(rows, includeSchemas),
        } satisfies ToolRegistryDiscoverOutput;
      }),

    catalogNamespaces: (input: ToolRegistryCatalogNamespacesInput) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(maxCatalogNamespacesLimit, input.limit ?? 50));

        const rows = yield* Effect.tryPromise({
          try: async () =>
            (await ctx.runQuery(runtimeInternal.control_plane.tool_registry.listWorkspaceNamespaces, {
              workspaceId,
              limit,
            })) as Array<{
              namespace: string;
              source: string;
              sourceId: string;
              sourceKind: string;
              toolCount: number;
              samplePaths: Array<string>;
            }>,
          catch: (cause) =>
            toRuntimeAdapterError(
              "catalog_namespaces",
              "Failed to catalog namespaces",
              String(cause),
            ),
        });

        return {
          namespaces: rows.map((row) => ({
            namespace: row.namespace,
            toolCount: row.toolCount,
            samplePaths: row.samplePaths,
            source: row.source,
            sourceKey: row.sourceId,
            description: describeSource({ sourceName: row.source, sourceKind: row.sourceKind }),
          })),
          total: rows.length,
        } satisfies ToolRegistryCatalogNamespacesOutput;
      }),

    catalogTools: (input: ToolRegistryCatalogToolsInput) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(maxCatalogToolsLimit, input.limit ?? 50));
        const queryText = (input.query ?? "").trim();
        const compact = input.compact === true;
        const includeSchemas = input.includeSchemas === true;
        const namespace = input.namespace?.trim();

        const rows =
          queryText.length > 0
            ? yield* searchWorkspaceToolsEffect(ctx, workspaceId, {
                query: queryText,
                namespace,
                limit: Math.max(limit * 4, 50),
              })
            : yield* listWorkspaceToolsEffect(ctx, workspaceId, {
                namespace,
                limit: Math.max(limit * 4, 50),
              });

        const rankedRows = rows
          .map((row) => ({
            row,
            score: scoreSummary(toSearchScoringSummary(row), queryText.toLowerCase()),
          }))
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);

        const selectedRows = rankedRows.map((item) => item.row);

        const summaries = includeSchemas
          ? (
              yield* hydrateRowsWithArtifactTools(ctx, selectedRows).pipe(
                Effect.map((entries) =>
                  entries.map(({ row, artifactTool }) =>
                    toToolSummary(row, {
                      includeSchemas,
                      compact,
                      artifactTool,
                    }),
                  ),
                ),
              )
            )
          : selectedRows.map((row) =>
              toToolSummary(row, {
                includeSchemas,
                compact,
              }),
            );

        return {
          results: summaries,
          total: summaries.length,
          refHintTable: mergeRefHintTables(rows, includeSchemas),
        } satisfies ToolRegistryCatalogToolsOutput;
      }),
  } as ToolRegistry;
};
