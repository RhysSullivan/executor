import { connectMcp, extractMcpResult } from "./mcp-runtime";
import { executePostmanRequest, type PostmanSerializedRunSpec } from "./postman-runtime";
import { normalizeGraphqlFieldVariables, selectGraphqlFieldEnvelope } from "./graphql-field-tools";
import { callMcpToolWithReconnect, executeGraphqlRequest, executeOpenApiRequest } from "./tool-source-execution";
import type { ToolApprovalMode, ToolCredentialSpec, ToolDefinition, ToolTypeMetadata } from "./types";
import { asRecord } from "./utils";

export interface SerializedTool {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  metadata?: ToolTypeMetadata;
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

type ToolWithRunSpec = ToolDefinition & { _runSpec?: SerializedTool["runSpec"] };
type McpConnection = Awaited<ReturnType<typeof connectMcp>>;
type McpConnectionCacheEntry = { promise: Promise<McpConnection> };

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
    metadata: tool.metadata,
    credential: tool.credential,
    _graphqlSource: tool._graphqlSource,
    _pseudoTool: tool._pseudoTool,
    runSpec: resolveSerializedRunSpec(tool),
  }));
}

export function rehydrateTools(
  serialized: SerializedTool[],
  baseTools: Map<string, ToolDefinition>,
): ToolDefinition[] {
  const mcpConnections = new Map<string, McpConnectionCacheEntry>();

  return serialized.map((st) => {
    const base: Omit<ToolDefinition, "run"> = {
      path: st.path,
      description: st.description,
      approval: st.approval,
      source: st.source,
      metadata: st.metadata,
      credential: st.credential,
      _graphqlSource: st._graphqlSource,
      _pseudoTool: st._pseudoTool,
    };

    if (st.runSpec.kind === "builtin") {
      const builtin = baseTools.get(st.path);
      if (builtin) return builtin;
      return { ...base, run: async () => { throw new Error(`Builtin tool '${st.path}' not found`); } };
    }

    if (st.runSpec.kind === "openapi") {
      const runSpec = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          return await executeOpenApiRequest(runSpec, input, context.credential?.headers);
        },
      };
    }

    if (st.runSpec.kind === "postman") {
      const runSpec = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          return await executePostmanRequest(runSpec, payload, context.credential?.headers);
        },
      };
    }

    if (st.runSpec.kind === "mcp") {
      const { url, transport, queryParams, toolName } = st.runSpec;
      const authHeaders = st.runSpec.authHeaders ?? {};
      return {
        ...base,
        run: async (input: unknown, context) => {
          const mergedHeaders = {
            ...authHeaders,
            ...(context.credential?.headers ?? {}),
          };
          const connKey = buildMcpConnectionKey(url, transport, mergedHeaders);
          let conn = await getOrCreateMcpConnection(
            mcpConnections,
            connKey,
            () => connectMcp(url, queryParams, transport, mergedHeaders),
          );

          const payload = asRecord(input);
          const result = await callMcpToolWithReconnect(
            () => conn.client.callTool({ name: toolName, arguments: payload }),
            async () => {
              try {
                await conn.close();
              } catch {
                // ignore
              }
              const newConnPromise = connectMcp(url, queryParams, transport, mergedHeaders);
              mcpConnections.set(connKey, { promise: newConnPromise });
              conn = await newConnPromise;
              return await conn.client.callTool({ name: toolName, arguments: payload });
            },
          );
          return extractMcpResult(result);
        },
      };
    }

    if (st.runSpec.kind === "graphql_raw") {
      const { endpoint, authHeaders } = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          const query = typeof payload.query === "string" ? payload.query : "";
          if (!query.trim()) {
            throw new Error("GraphQL query string is required");
          }
          const variables = payload.variables;
          return await executeGraphqlRequest(endpoint, authHeaders, query, variables, context.credential?.headers);
        },
      };
    }

    if (st.runSpec.kind === "graphql_field") {
      const { endpoint, operationName, queryTemplate, authHeaders, argNames } = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          const hasExplicitQuery = typeof payload.query === "string" && payload.query.trim().length > 0;
          const query = hasExplicitQuery ? String(payload.query) : queryTemplate;

          let variables = payload.variables;
          if (variables === undefined && !hasExplicitQuery) {
            variables = normalizeGraphqlFieldVariables(argNames ?? [], payload);
          }

          const envelope = await executeGraphqlRequest(endpoint, authHeaders, query, variables, context.credential?.headers);
          return selectGraphqlFieldEnvelope(envelope, operationName);
        },
      };
    }

    return { ...base, run: async () => { throw new Error(`Unknown run spec kind for '${st.path}'`); } };
  });
}
