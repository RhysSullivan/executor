import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect } from "effect";

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
      return new McpConnectionError({
        transport: "stdio",
        message: "MCP stdio transport requires a command",
      });
    }

    return connectClient({
      transport: "stdio",
      createTransport: () =>
        new StdioClientTransport({
          command,
          args: input.args ? [...input.args] : undefined,
          env: input.env ? ({ ...process.env, ...input.env } as Record<string, string>) : undefined,
          cwd: input.cwd?.trim().length ? input.cwd.trim() : undefined,
        }),
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
