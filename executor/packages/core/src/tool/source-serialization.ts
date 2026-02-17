import { connectMcp, extractMcpResult } from "../mcp-runtime";
import { executePostmanRequest, type PostmanSerializedRunSpec } from "../postman-runtime";
import { normalizeGraphqlFieldVariables, selectGraphqlFieldEnvelope } from "../graphql/field-tools";
import { callMcpToolWithReconnect, executeGraphqlRequest, executeOpenApiRequest } from "./source-execution";
import { Result } from "better-result";
import { z } from "zod";
import type { ToolApprovalMode, ToolCredentialSpec, ToolDefinition, ToolRunContext, ToolTyping } from "../types";

const recordSchema = z.record(z.unknown());

function toRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export interface SerializedTool {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  typing?: ToolTyping;
  credential?: ToolCredentialSpec;
  _graphqlSource?: string;
  _pseudoTool?: boolean;
  runSpec:
    | {
        kind: "openapi";
        baseUrl: string;
        method: string;
        pathTemplate: string;
        parameters: Array<{ name: string; in: string; required: boolean; schema: Record<string, unknown> }>;
        authHeaders: Record<string, string>;
      }
    | {
        kind: "mcp";
        url: string;
        transport?: "sse" | "streamable-http";
        queryParams?: Record<string, string>;
        authHeaders: Record<string, string>;
        toolName: string;
      }
    | PostmanSerializedRunSpec
    | {
        kind: "graphql_raw";
        endpoint: string;
        authHeaders: Record<string, string>;
      }
    | {
        kind: "graphql_field";
        endpoint: string;
        operationName: string;
        operationType: "query" | "mutation";
        queryTemplate: string;
        argNames?: string[];
        authHeaders: Record<string, string>;
      }
    | { kind: "builtin" };
}

const openApiRunSpecSchema = z.object({
  kind: z.literal("openapi"),
  baseUrl: z.string(),
  method: z.string(),
  pathTemplate: z.string(),
  parameters: z.array(z.object({
    name: z.string(),
    in: z.string(),
    required: z.boolean(),
    schema: z.record(z.unknown()),
  })),
  authHeaders: z.record(z.string()),
});

const mcpRunSpecSchema = z.object({
  kind: z.literal("mcp"),
  url: z.string(),
  transport: z.enum(["sse", "streamable-http"]).optional(),
  queryParams: z.record(z.string()).optional(),
  authHeaders: z.record(z.string()),
  toolName: z.string(),
});

const postmanRunSpecSchema: z.ZodType<PostmanSerializedRunSpec> = z.object({
  kind: z.literal("postman"),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  queryParams: z.array(z.object({ key: z.string(), value: z.string() })),
  body: z.union([
    z.object({ kind: z.literal("urlencoded"), entries: z.array(z.object({ key: z.string(), value: z.string() })) }),
    z.object({ kind: z.literal("raw"), text: z.string() }),
  ]).optional(),
  variables: z.record(z.string()),
  authHeaders: z.record(z.string()),
});

const graphqlRawRunSpecSchema = z.object({
  kind: z.literal("graphql_raw"),
  endpoint: z.string(),
  authHeaders: z.record(z.string()),
});

const graphqlFieldRunSpecSchema = z.object({
  kind: z.literal("graphql_field"),
  endpoint: z.string(),
  operationName: z.string(),
  operationType: z.enum(["query", "mutation"]),
  queryTemplate: z.string(),
  argNames: z.array(z.string()).optional(),
  authHeaders: z.record(z.string()),
});

const builtinRunSpecSchema = z.object({ kind: z.literal("builtin") });

const toolTypedRefSchema = z.object({
  kind: z.literal("openapi_operation"),
  sourceKey: z.string(),
  operationId: z.string(),
});

const toolTypingSchema: z.ZodType<ToolTyping> = z.object({
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  inputHint: z.string().optional(),
  outputHint: z.string().optional(),
  requiredInputKeys: z.array(z.string()).optional(),
  previewInputKeys: z.array(z.string()).optional(),
  typedRef: toolTypedRefSchema.optional(),
});

const toolCredentialSpecSchema: z.ZodType<ToolCredentialSpec> = z.object({
  sourceKey: z.string(),
  mode: z.enum(["workspace", "account", "organization"]),
  authType: z.enum(["bearer", "apiKey", "basic"]),
  headerName: z.string().optional(),
  staticSecretJson: z.record(z.unknown()).optional(),
});

const graphqlObjectInputSchema = z.object({
  query: z.string().optional(),
  variables: z.unknown().optional(),
}).catchall(z.unknown());

const graphqlInvocationInputSchema = z.union([
  z.string(),
  graphqlObjectInputSchema,
]);

const invalidSerializedToolFallbackSchema = z.object({
  path: z.string().optional(),
  source: z.string().optional(),
});

function normalizeGraphqlInvocationInput(input: unknown): {
  payload: Record<string, unknown>;
  query: string;
  variables: unknown;
  hasExplicitQuery: boolean;
} {
  const parsedInput = graphqlInvocationInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const payload = toRecord(input);
    return {
      payload,
      query: "",
      variables: payload.variables,
      hasExplicitQuery: false,
    };
  }

  if (typeof parsedInput.data === "string") {
    const query = parsedInput.data.trim();
    return {
      payload: { query: parsedInput.data },
      query,
      variables: undefined,
      hasExplicitQuery: query.length > 0,
    };
  }

  const query = (parsedInput.data.query ?? "").trim();
  return {
    payload: parsedInput.data,
    query,
    variables: parsedInput.data.variables,
    hasExplicitQuery: query.length > 0,
  };
}

const serializedRunSpecSchema = z.union([
  openApiRunSpecSchema,
  mcpRunSpecSchema,
  postmanRunSpecSchema,
  graphqlRawRunSpecSchema,
  graphqlFieldRunSpecSchema,
  builtinRunSpecSchema,
]);

const serializedToolSchema: z.ZodType<SerializedTool> = z.object({
  path: z.string(),
  description: z.string(),
  approval: z.enum(["auto", "required"]),
  source: z.string().optional(),
  typing: toolTypingSchema.optional(),
  credential: toolCredentialSpecSchema.optional(),
  _graphqlSource: z.string().optional(),
  _pseudoTool: z.boolean().optional(),
  runSpec: serializedRunSpecSchema,
});

type ToolWithRunSpec = ToolDefinition & { _runSpec?: SerializedTool["runSpec"] };
type McpConnection = Awaited<ReturnType<typeof connectMcp>>;
type McpConnectionCacheEntry = { promise: Promise<McpConnection> };
const sharedMcpConnections = new Map<string, McpConnectionCacheEntry>();

function resolveSerializedRunSpec(tool: ToolDefinition): SerializedTool["runSpec"] {
  const runSpec = (tool as ToolWithRunSpec)._runSpec;
  return runSpec ?? { kind: "builtin" };
}

function buildMcpConnectionKey(
  url: string,
  transport: "sse" | "streamable-http" | undefined,
  headers: Record<string, string>,
): string {
  const headerEntries = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
  return `${url}|${transport ?? ""}|${headerEntries}`;
}

function getOrCreateMcpConnection(
  mcpConnections: Map<string, McpConnectionCacheEntry>,
  connKey: string,
  createConnection: () => Promise<McpConnection>,
): Promise<McpConnection> {
  const existing = mcpConnections.get(connKey);
  if (existing) {
    return existing.promise;
  }

  const promise = createConnection();
  mcpConnections.set(connKey, { promise });
  return promise;
}

export function serializeTools(tools: ToolDefinition[]): SerializedTool[] {
  return tools.map((tool) => ({
    path: tool.path,
    description: tool.description,
    approval: tool.approval,
    source: tool.source,
    typing: tool.typing,
    credential: tool.credential,
    _graphqlSource: tool._graphqlSource,
    _pseudoTool: tool._pseudoTool,
    runSpec: resolveSerializedRunSpec(tool),
  }));
}

export function parseSerializedTool(value: unknown): Result<SerializedTool, Error> {
  const parsed = serializedToolSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(new Error(parsed.error.message));
  }

  return Result.ok(parsed.data);
}

export async function executeSerializedTool(
  serialized: SerializedTool,
  input: unknown,
  context: ToolRunContext,
  baseTools: ReadonlyMap<string, ToolDefinition>,
): Promise<unknown> {
  if (serialized.runSpec.kind === "builtin") {
    const builtin = baseTools.get(serialized.path);
    if (!builtin) {
      throw new Error(`Builtin tool '${serialized.path}' not found`);
    }
    return await builtin.run(input, context);
  }

  if (serialized.runSpec.kind === "openapi") {
    const response = await executeOpenApiRequest(serialized.runSpec, input, context.credential?.headers);
    if (response.isErr()) {
      throw new Error(response.error.message);
    }
    return response.value;
  }

  if (serialized.runSpec.kind === "postman") {
    const payload = toRecord(input);
    return await executePostmanRequest(serialized.runSpec, payload, context.credential?.headers);
  }

  if (serialized.runSpec.kind === "mcp") {
    const { url, transport, queryParams, toolName } = serialized.runSpec;
    const authHeaders = serialized.runSpec.authHeaders ?? {};
    const mergedHeaders = {
      ...authHeaders,
      ...(context.credential?.headers ?? {}),
    };
    const connKey = buildMcpConnectionKey(url, transport, mergedHeaders);
    let conn = await getOrCreateMcpConnection(
      sharedMcpConnections,
      connKey,
      () => connectMcp(url, queryParams, transport, mergedHeaders),
    );

    const payload = toRecord(input);
    const result = await callMcpToolWithReconnect(
      () => conn.client.callTool({ name: toolName, arguments: payload }),
      async () => {
        try {
          await conn.close();
        } catch {
          // ignore
        }
        const newConnPromise = connectMcp(url, queryParams, transport, mergedHeaders);
        sharedMcpConnections.set(connKey, { promise: newConnPromise });
        conn = await newConnPromise;
        return await conn.client.callTool({ name: toolName, arguments: payload });
      },
    );
    return extractMcpResult(result);
  }

  if (serialized.runSpec.kind === "graphql_raw") {
    const normalized = normalizeGraphqlInvocationInput(input);
    if (!normalized.hasExplicitQuery) {
      throw new Error("GraphQL query string is required");
    }
    const response = await executeGraphqlRequest(
      serialized.runSpec.endpoint,
      serialized.runSpec.authHeaders,
      normalized.query,
      normalized.variables,
      context.credential?.headers,
    );
    if (response.isErr()) {
      throw new Error(response.error.message);
    }
    return response.value;
  }

  if (serialized.runSpec.kind === "graphql_field") {
    const normalized = normalizeGraphqlInvocationInput(input);
    const query = normalized.hasExplicitQuery ? normalized.query : serialized.runSpec.queryTemplate;

    let variables = normalized.variables;
    if (variables === undefined && !normalized.hasExplicitQuery) {
      variables = normalizeGraphqlFieldVariables(serialized.runSpec.argNames ?? [], normalized.payload);
    }

    const envelopeResult = await executeGraphqlRequest(
      serialized.runSpec.endpoint,
      serialized.runSpec.authHeaders,
      query,
      variables,
      context.credential?.headers,
    );
    if (envelopeResult.isErr()) {
      throw new Error(envelopeResult.error.message);
    }

    return selectGraphqlFieldEnvelope(envelopeResult.value, serialized.runSpec.operationName);
  }

  throw new Error(`Unknown run spec kind for '${serialized.path}'`);
}

export function rehydrateTools(
  serialized: ReadonlyArray<unknown>,
  baseTools: Map<string, ToolDefinition>,
): ToolDefinition[] {
  return serialized.map((candidate, index) => {
    const parsed = parseSerializedTool(candidate);
    if (parsed.isErr()) {
      const fallback = invalidSerializedToolFallbackSchema.safeParse(candidate);
      const path = fallback.success && fallback.data.path && fallback.data.path.trim().length > 0
        ? fallback.data.path
        : `invalid_serialized_tool_${index + 1}`;

      return {
        path,
        description: "Invalid serialized tool definition",
        approval: "required",
        source: fallback.success ? fallback.data.source : undefined,
        run: async () => {
          throw new Error(`Invalid serialized tool '${path}': ${parsed.error.message}`);
        },
      };
    }

    const st = parsed.value;
    const base: Omit<ToolDefinition, "run"> = {
      path: st.path,
      description: st.description,
      approval: st.approval,
      source: st.source,
      typing: st.typing,
      credential: st.credential,
      _graphqlSource: st._graphqlSource,
      _pseudoTool: st._pseudoTool,
    };

    if (st.runSpec.kind === "builtin") {
      const builtin = baseTools.get(st.path);
      if (builtin) return builtin;
    }

    return {
      ...base,
      run: async (input: unknown, context) => await executeSerializedTool(st, input, context, baseTools),
    };
  });
}
