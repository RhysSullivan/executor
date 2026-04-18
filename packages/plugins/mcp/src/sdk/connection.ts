import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect } from "effect";

// NOTE: `StdioClientTransport` is NOT imported eagerly. The upstream module
// (`@modelcontextprotocol/sdk/client/stdio.js`) touches `node:child_process`
// at evaluation time, which crashes workerd (incl. vitest-pool-workers) at
// SIGSEGV on module instantiation. Cloud callers set
// `dangerouslyAllowStdioMCP: false` and never reach the stdio branch below;
// prod bundles that DO use stdio load it via a dynamic import inside the
// stdio branch of `createMcpConnector`.

import type { McpRemoteSourceData, McpStdioSourceData } from "./types";
import { McpConnectionError } from "./errors";

// ---------------------------------------------------------------------------
// Connection type
// ---------------------------------------------------------------------------

export type McpConnection = {
  readonly client: Client;
  readonly close: () => Promise<void>;
};

export type McpConnector = Effect.Effect<McpConnection, McpConnectionError>;

// ---------------------------------------------------------------------------
// Connector input — extends stored source data with resolved auth
// ---------------------------------------------------------------------------

export type RemoteConnectorInput = Omit<McpRemoteSourceData, "auth" | "remoteTransport"> & {
  readonly remoteTransport?: McpRemoteSourceData["remoteTransport"];
  readonly authProvider?: OAuthClientProvider;
};

export type StdioConnectorInput = McpStdioSourceData;

export type ConnectorInput = RemoteConnectorInput | StdioConnectorInput;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildEndpointUrl = (endpoint: string, queryParams: Record<string, string>): URL => {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }
  return url;
};

const createClient = (): Client =>
  new Client(
    { name: "executor-mcp", version: "0.1.0" },
    { capabilities: { elicitation: { form: {}, url: {} } } },
  );

const connectionFromClient = (client: Client): McpConnection => ({
  client,
  close: () => client.close(),
});

const connectClient = (input: {
  transport: string;
  createTransport: () => Parameters<Client["connect"]>[0];
}): Effect.Effect<McpConnection, McpConnectionError> =>
  Effect.gen(function* () {
    const client = createClient();
    const transportInstance = input.createTransport();

    yield* Effect.tryPromise({
      try: () => client.connect(transportInstance),
      catch: (cause) =>
        new McpConnectionError({
          transport: input.transport,
          message: `Failed connecting via ${input.transport}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });

    return connectionFromClient(client);
  });

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const createMcpConnector = (input: ConnectorInput): McpConnector => {
  if (input.transport === "stdio") {
    const command = input.command.trim();
    if (!command) {
      return Effect.fail(
        new McpConnectionError({
          transport: "stdio",
          message: "MCP stdio transport requires a command",
        }),
      );
    }

    return Effect.gen(function* () {
      // Dynamic import so the underlying module (which evaluates
      // `node:child_process`) is only loaded when stdio is actually used.
      const { createStdioTransport } = yield* Effect.tryPromise({
        try: () => import("./stdio-connector"),
        catch: (cause) =>
          new McpConnectionError({
            transport: "stdio",
            message: `Failed to load stdio transport module: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      });

      return yield* connectClient({
        transport: "stdio",
        createTransport: () =>
          createStdioTransport({
            command,
            args: input.args,
            env: input.env,
            cwd: input.cwd?.trim().length ? input.cwd.trim() : undefined,
          }),
      });
    });
  }

  // Remote transport
  const headers = input.headers ?? {};
  const remoteTransport = input.remoteTransport ?? "auto";
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

  const endpoint = buildEndpointUrl(input.endpoint, input.queryParams ?? {});

  const connectStreamableHttp = connectClient({
    transport: "streamable-http",
    createTransport: () =>
      new StreamableHTTPClientTransport(endpoint, {
        requestInit,
        authProvider: input.authProvider,
      }),
  });

  const connectSse = connectClient({
    transport: "sse",
    createTransport: () =>
      new SSEClientTransport(endpoint, {
        requestInit,
        authProvider: input.authProvider,
      }),
  });

  if (remoteTransport === "streamable-http") return connectStreamableHttp;
  if (remoteTransport === "sse") return connectSse;

  // auto — try streamable-http first, fall back to SSE
  return connectStreamableHttp.pipe(Effect.catchAll(() => connectSse));
};
