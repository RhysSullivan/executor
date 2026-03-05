import {
  type CanonicalToolDescriptor,
  type Source,
} from "@executor-v2/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import {
  collectSourceHeaders,
  parseSourceConfig,
  readMcpTransportFromConfig,
  readQueryParamsFromConfig,
  resolveSourceEndpoint,
  type McpTransportPreference,
} from "./source-config";
import { ToolProviderError, type ToolProvider } from "./tool-providers";

type McpClientLike = {
  listTools: () => Promise<unknown>;
  callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
};

type McpConnection = {
  client: McpClientLike;
  close: () => Promise<void>;
};

type McpConnectorInput = {
  endpoint: string;
  transport: McpTransportPreference;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
};

export type McpConnector = (input: McpConnectorInput) => Promise<McpConnection>;

type McpToolSummary = {
  name: string;
  description: string | null;
};

const McpInvocationPayloadSchema = Schema.Struct({
  kind: Schema.Literal("mcp_tool"),
  toolName: Schema.String,
});

const McpInvokeArgsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const decodeMcpInvocationPayload = Schema.decodeUnknown(McpInvocationPayloadSchema);
const decodeMcpInvokeArgs = Schema.decodeUnknown(McpInvokeArgsSchema);

const toMcpProviderError = (
  operation: string,
  message: string,
  cause: unknown,
): ToolProviderError =>
  new ToolProviderError({
    operation,
    providerKind: "mcp",
    message,
    details: ParseResult.isParseError(cause)
      ? ParseResult.TreeFormatter.formatErrorSync(cause)
      : String(cause),
  });

const mergeHeadersForFetch = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Record<string, string>,
): Promise<Response> => {
  const mergedHeaders = new Headers(init?.headers ?? {});

  for (const [key, value] of Object.entries(headers)) {
    mergedHeaders.set(key, value);
  }

  return fetch(input, {
    ...init,
    headers: mergedHeaders,
  });
};

const createEndpoint = (
  endpoint: string,
  queryParams: Record<string, string>,
): URL => {
  const url = new URL(endpoint);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  return url;
};

const connectMcpWithSdk: McpConnector = async (input) => {
  const endpoint = createEndpoint(input.endpoint, input.queryParams);
  const requestInit = Object.keys(input.headers).length > 0
    ? { headers: input.headers }
    : undefined;

  const client = new Client(
    {
      name: "executor-v2-engine",
      version: "0.1.0",
    },
    { capabilities: {} },
  );

  if (input.transport === "sse") {
    await client.connect(new SSEClientTransport(endpoint, {
      requestInit,
      eventSourceInit: requestInit
        ? {
            fetch: (requestInput, requestOptions) =>
              mergeHeadersForFetch(requestInput, requestOptions, input.headers),
          }
        : undefined,
    }));

    return {
      client,
      close: () => client.close(),
    };
  }

  if (input.transport === "streamable-http") {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit,
    }));

    return {
      client,
      close: () => client.close(),
    };
  }

  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit,
    }));

    return {
      client,
      close: () => client.close(),
    };
  } catch {
    await client.connect(new SSEClientTransport(endpoint, {
      requestInit,
      eventSourceInit: requestInit
        ? {
            fetch: (requestInput, requestOptions) =>
              mergeHeadersForFetch(requestInput, requestOptions, input.headers),
          }
        : undefined,
    }));

    return {
      client,
      close: () => client.close(),
    };
  }
};

const extractMcpTools = (value: unknown): Array<McpToolSummary> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool): McpToolSummary | null => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        return null;
      }

      const toolRecord = tool as Record<string, unknown>;
      const name = typeof toolRecord.name === "string" ? toolRecord.name.trim() : "";
      if (name.length === 0) {
        return null;
      }

      const description = typeof toolRecord.description === "string"
        ? toolRecord.description
        : null;

      return {
        name,
        description,
      };
    })
    .filter((tool): tool is McpToolSummary => tool !== null);
};

const sanitizeToolId = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : "tool";
};

const uniqueToolId = (value: string, byBase: Map<string, number>): string => {
  const base = sanitizeToolId(value);
  const count = (byBase.get(base) ?? 0) + 1;
  byBase.set(base, count);

  return count === 1 ? base : `${base}_${count}`;
};

const withMcpConnection = <A>(
  source: Source,
  connector: McpConnector,
  operation: string,
  credentialHeaders: Readonly<Record<string, string>>,
  run: (connection: McpConnection) => Effect.Effect<A, ToolProviderError>,
): Effect.Effect<A, ToolProviderError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = parseSourceConfig(source);
      const endpoint = resolveSourceEndpoint(source, config, ["url", "endpoint"]);
      if (endpoint.trim().length === 0) {
        return yield* new ToolProviderError({
          operation,
          providerKind: "mcp",
          message: "MCP source endpoint is required",
          details: source.id,
        });
      }

      const connection = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            connector({
              endpoint,
              transport: readMcpTransportFromConfig(config),
              queryParams: readQueryParamsFromConfig(config),
              headers: {
                ...collectSourceHeaders(config),
                ...credentialHeaders,
              },
            }),
          catch: (cause) =>
            toMcpProviderError(
              operation,
              `Failed to connect to MCP source: ${source.name}`,
              cause,
            ),
        }),
        (connected) =>
          Effect.tryPromise({
            try: () => connected.close(),
            catch: () => undefined,
          }).pipe(Effect.orDie),
      );

      return yield* run(connection);
    }),
  );

export type MakeMcpToolProviderOptions = {
  connector?: McpConnector;
};

export const makeMcpToolProvider = (
  options: MakeMcpToolProviderOptions = {},
): ToolProvider => {
  const connector = options.connector ?? connectMcpWithSdk;

  return {
    kind: "mcp",

    discoverFromSource: (source) =>
      withMcpConnection(
        source,
        connector,
        "discover.connect",
        {},
        (connection) =>
          Effect.gen(function* () {
            const listed = yield* Effect.tryPromise({
              try: () => connection.client.listTools(),
              catch: (cause) =>
                toMcpProviderError(
                  "discover.list_tools",
                  `Failed to list MCP tools for source: ${source.name}`,
                  cause,
                ),
            });

            const discoveredTools = extractMcpTools(listed);
            const usedToolIds = new Map<string, number>();

            const tools: ReadonlyArray<CanonicalToolDescriptor> = discoveredTools.map((tool) => ({
              providerKind: "mcp",
              sourceId: source.id,
              workspaceId: source.workspaceId,
              toolId: uniqueToolId(tool.name, usedToolIds),
              name: tool.name,
              description: tool.description,
              invocationMode: "mcp",
              availability: "remote_capable",
              providerPayload: {
                kind: "mcp_tool",
                toolName: tool.name,
              },
            }));

            return {
              sourceHash: source.sourceHash,
              tools,
            };
          }),
      ),

    invoke: (input) =>
      Effect.gen(function* () {
        if (!input.source) {
          return yield* new ToolProviderError({
            operation: "invoke.validate_source",
            providerKind: "mcp",
            message: "MCP provider requires a source",
            details: null,
          });
        }

        const payload = yield* decodeMcpInvocationPayload(input.tool.providerPayload).pipe(
          Effect.mapError((cause) =>
            toMcpProviderError(
              "invoke.decode_payload",
              `Invalid MCP invocation payload for tool: ${input.tool.toolId}`,
              cause,
            ),
          ),
        );

        const args = yield* decodeMcpInvokeArgs(input.args).pipe(
          Effect.mapError((cause) =>
            toMcpProviderError(
              "invoke.decode_args",
              `Invalid MCP tool args for tool: ${input.tool.toolId}`,
              cause,
            ),
          ),
        );

        return yield* withMcpConnection(
          input.source,
          connector,
          "invoke.connect",
          input.credentialHeaders ?? {},
          (connection) =>
            Effect.gen(function* () {
              const result = yield* Effect.tryPromise({
                try: () =>
                  connection.client.callTool({
                    name: payload.toolName,
                    arguments: args,
                  }),
                catch: (cause) =>
                  toMcpProviderError(
                    "invoke.call_tool",
                    `Failed MCP tool invocation: ${payload.toolName}`,
                    cause,
                  ),
              });

              const isError = Boolean(
                result &&
                typeof result === "object" &&
                (result as { isError?: unknown }).isError === true,
              );

              return {
                output: result,
                isError,
              };
            }),
        );
      }),
  };
};
