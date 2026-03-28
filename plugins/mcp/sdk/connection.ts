import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { McpConnection, McpConnector } from "./tools";

export type McpTransportPreference = "auto" | "streamable-http" | "sse" | "stdio";

export type CreateSdkMcpConnectorInput = {
  endpoint?: string;
  transport?: McpTransportPreference;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  clientName?: string;
  clientVersion?: string;
  command?: string;
  args?: ReadonlyArray<string>;
  env?: Record<string, string>;
  cwd?: string;
};

export class McpConnectionError extends Data.TaggedError("McpConnectionError")<{
  readonly transport: McpTransportPreference;
  readonly message: string;
  readonly cause: unknown;
}> {}

export const isMcpStdioTransport = (
  input: Pick<CreateSdkMcpConnectorInput, "transport" | "command">,
): boolean =>
  input.transport === "stdio"
  || (typeof input.command === "string" && input.command.trim().length > 0);

const mcpConnectionError = (input: {
  transport: McpTransportPreference;
  message: string;
  cause: unknown;
}): McpConnectionError => new McpConnectionError(input);

const createEndpoint = (input: {
  endpoint: string | undefined;
  queryParams: Record<string, string>;
  transport: Exclude<McpTransportPreference, "stdio">;
}): Effect.Effect<URL, McpConnectionError, never> =>
  Effect.try({
    try: () => {
      if (!input.endpoint) {
        throw new Error("MCP endpoint is required for HTTP/SSE transports");
      }

      const url = new URL(input.endpoint);

      for (const [key, value] of Object.entries(input.queryParams)) {
        url.searchParams.set(key, value);
      }

      return url;
    },
    catch: (cause) =>
      mcpConnectionError({
        transport: input.transport,
        message: "Failed building MCP endpoint URL",
        cause,
      }),
  });

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const mergeHeadersForFetch = (
  input: FetchInput,
  init: FetchInit,
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

const connectionFromClient = (client: Client): McpConnection => ({
  client,
  close: () => client.close(),
});

const closeClient = (client: Client): Effect.Effect<void, never, never> =>
  Effect.tryPromise({
    try: () => client.close(),
    catch: (cause) =>
      mcpConnectionError({
        transport: "auto",
        message: "Failed closing MCP client",
        cause,
      }),
  }).pipe(Effect.ignore);

const connectClient = (input: {
  createClient: () => Client;
  transport: McpTransportPreference;
  createTransport: () => Parameters<Client["connect"]>[0];
}): Effect.Effect<McpConnection, McpConnectionError, never> =>
  Effect.gen(function* () {
    const client = input.createClient();
    const transportInstance = input.createTransport();

    return yield* Effect.tryPromise({
      try: () => client.connect(transportInstance),
      catch: (cause) =>
        mcpConnectionError({
          transport: input.transport,
          message:
            `Failed connecting to MCP server via ${input.transport}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          cause,
        }),
    }).pipe(
      Effect.as(connectionFromClient(client)),
      Effect.onError(() => closeClient(client)),
    );
  });

export const createSdkMcpConnector = (
  input: CreateSdkMcpConnectorInput,
): McpConnector => {
  const headers = input.headers ?? {};
  const transport = isMcpStdioTransport(input)
    ? "stdio"
    : (input.transport ?? "auto");
  const requestInit = Object.keys(headers).length > 0
    ? { headers }
    : undefined;

  const createClient = () =>
    new Client(
      {
        name: input.clientName ?? "executor-codemode-mcp",
        version: input.clientVersion ?? "0.1.0",
      },
      { capabilities: { elicitation: { form: {}, url: {} } } },
    );

  return Effect.gen(function* () {
    if (transport === "stdio") {
      const command = input.command?.trim();
      if (!command) {
        return yield* mcpConnectionError({
          transport: "stdio",
          message: "MCP stdio transport requires a command",
          cause: new Error("Missing MCP stdio command"),
        });
      }

      return yield* connectClient({
        createClient,
        transport: "stdio",
        createTransport: () =>
          new StdioClientTransport({
            command,
            args: input.args ? [...input.args] : undefined,
            env: input.env,
            cwd: input.cwd?.trim().length ? input.cwd.trim() : undefined,
          }),
      });
    }

    const endpoint = yield* createEndpoint({
      endpoint: input.endpoint,
      queryParams: input.queryParams ?? {},
      transport,
    });

    const connectStreamableHttp = connectClient({
      createClient,
      transport: "streamable-http",
      createTransport: () =>
        new StreamableHTTPClientTransport(endpoint, {
          requestInit,
          authProvider: input.authProvider,
        }),
    });

    if (transport === "streamable-http") {
      return yield* connectStreamableHttp;
    }

    const connectSse = connectClient({
      createClient,
      transport: "sse",
      createTransport: () =>
        new SSEClientTransport(endpoint, {
          authProvider: input.authProvider,
          requestInit,
          eventSourceInit: requestInit
            ? {
                fetch: (requestInput: FetchInput, requestOptions: FetchInit) =>
                  mergeHeadersForFetch(requestInput, requestOptions, headers),
              }
            : undefined,
        }),
    });

    if (transport === "sse") {
      return yield* connectSse;
    }

    return yield* connectStreamableHttp.pipe(
      Effect.catchAll(() => connectSse),
    );
  });
};
