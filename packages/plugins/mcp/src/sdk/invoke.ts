// ---------------------------------------------------------------------------
// MCP tool invocation — shared helper called from plugin.invokeTool.
//
// Responsible for:
//   1. Finding/creating a cached MCP client connection for the source.
//   2. Installing a per-invocation `ElicitRequestSchema` handler that
//      bridges MCP's elicit capability into the host's elicit function
//      threaded via `InvokeToolInput.elicit`.
//   3. Calling `client.callTool({ name, arguments })`.
//   4. Retrying once on connection failure (invalidate + reconnect).
// ---------------------------------------------------------------------------

import { Cause, Effect, Exit, Schema, type ScopedCache } from "effect";

import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  FormElicitation,
  UrlElicitation,
  type Elicit,
  type ElicitationRequest,
} from "@executor/sdk";

import { McpConnectionError } from "./errors";
import type { McpConnection } from "./connection";
import type { McpStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const connectionCacheKey = (sd: McpStoredSourceData): string =>
  sd.transport === "stdio"
    ? `stdio:${sd.command}`
    : `remote:${sd.endpoint}`;

// ---------------------------------------------------------------------------
// Elicitation bridge — decode incoming MCP ElicitRequest, route through
// the host's elicit function, marshal the response back to MCP shape.
// ---------------------------------------------------------------------------

const McpElicitParams = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("url"),
    message: Schema.String,
    url: Schema.String,
    elicitationId: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    mode: Schema.optional(Schema.Literal("form")),
    message: Schema.String,
    requestedSchema: Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  }),
);
type McpElicitParams = typeof McpElicitParams.Type;

const decodeElicitParams = Schema.decodeUnknownSync(McpElicitParams);

const toElicitationRequest = (params: McpElicitParams): ElicitationRequest =>
  params.mode === "url"
    ? new UrlElicitation({
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId ?? params.id ?? "",
      })
    : new FormElicitation({
        message: params.message,
        requestedSchema: params.requestedSchema,
      });

const installElicitationHandler = (
  client: McpConnection["client"],
  elicit: Elicit,
): void => {
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request: { params: unknown }) => {
      const params = decodeElicitParams(request.params);
      const req = toElicitationRequest(params);
      // Use runPromiseExit so we can inspect typed failures — `elicit`
      // fails with `ElicitationDeclinedError` on decline/cancel, which
      // we translate into the equivalent MCP elicit response instead of
      // surfacing as a JSON-RPC error.
      const exit = await Effect.runPromiseExit(elicit(req));
      if (Exit.isSuccess(exit)) {
        const response = exit.value;
        return {
          action: response.action,
          ...(response.action === "accept" && response.content
            ? { content: response.content }
            : {}),
        };
      }
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        const err = failure.value as {
          readonly _tag?: string;
          readonly action?: "decline" | "cancel";
        };
        if (err._tag === "ElicitationDeclinedError") {
          return { action: err.action ?? "decline" };
        }
      }
      throw Cause.squash(exit.cause);
    },
  );
};

// ---------------------------------------------------------------------------
// Single tool call — install handler, callTool, return raw result
// ---------------------------------------------------------------------------

const useConnection = (
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
  elicit: Elicit,
): Effect.Effect<unknown, Error> =>
  Effect.gen(function* () {
    installElicitationHandler(connection.client, elicit);
    return yield* Effect.tryPromise({
      try: () => connection.client.callTool({ name: toolName, arguments: args }),
      catch: (cause) =>
        new Error(
          `MCP tool call failed for ${toolName}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
    });
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InvokeMcpToolInput {
  readonly toolId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly sourceData: McpStoredSourceData;
  readonly resolveConnector: () => Effect.Effect<McpConnection, McpConnectionError>;
  readonly connectionCache: ScopedCache.ScopedCache<
    string,
    McpConnection,
    McpConnectionError
  >;
  readonly pendingConnectors: Map<
    string,
    Effect.Effect<McpConnection, McpConnectionError>
  >;
  readonly elicit: Elicit;
}

export const invokeMcpTool = (
  input: InvokeMcpToolInput,
): Effect.Effect<unknown, Error> =>
  Effect.gen(function* () {
    const cacheKey = connectionCacheKey(input.sourceData);
    const args = asRecord(input.args);

    // Register the connector for the cache lookup (side-channel pattern
    // — the ScopedCache lookup closure reads from `pendingConnectors`).
    const connector = input.resolveConnector();
    input.pendingConnectors.set(cacheKey, connector);

    const firstConnection = yield* input.connectionCache.get(cacheKey).pipe(
      Effect.mapError(
        (err) =>
          new Error(
            `Failed connecting to MCP server: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      ),
    );

    return yield* useConnection(
      firstConnection,
      input.toolName,
      args,
      input.elicit,
    ).pipe(
      // On failure, invalidate the cache and retry once with a fresh
      // connection. Matches the old invoker's retry-once semantics.
      Effect.catchAll(() =>
        Effect.gen(function* () {
          yield* input.connectionCache.invalidate(cacheKey);
          input.pendingConnectors.set(cacheKey, connector);
          const fresh = yield* input.connectionCache.get(cacheKey).pipe(
            Effect.mapError(
              (err) =>
                new Error(
                  `Failed reconnecting to MCP server: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
            ),
          );
          return yield* useConnection(
            fresh,
            input.toolName,
            args,
            input.elicit,
          );
        }),
      ),
    );
  }).pipe(Effect.scoped);
