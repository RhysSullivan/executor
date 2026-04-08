// ---------------------------------------------------------------------------
// MCP tool invoker — bridges the binding store + MCP client into SDK invoker
// ---------------------------------------------------------------------------

import { Effect, Schema, type ScopedCache } from "effect";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type ToolId,
  type ToolInvoker,
  ToolInvocationResult,
  ToolInvocationError,
  ToolAnnotations,
  ElicitationResponse,
  FormElicitation,
  UrlElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
  type ScopeId,
  type SecretId,
  type InvokeOptions,
} from "@executor/core";

import type { McpBindingStore } from "./binding-store";
import type { McpStoredSourceData } from "./types";
import { McpConnectionError } from "./errors";
import {
  createMcpConnector,
  type McpConnection,
  type ConnectorInput,
} from "./connection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type Secrets = {
  readonly resolve: (
    secretId: SecretId,
    scopeId: ScopeId,
  ) => Effect.Effect<string, unknown>;
};

// ---------------------------------------------------------------------------
// OAuth provider factory
// ---------------------------------------------------------------------------

const makeOAuthProvider = (
  accessToken: string,
  tokenType: string,
  refreshToken?: string,
): OAuthClientProvider => ({
  get redirectUrl() { return "http://localhost/oauth/callback"; },
  get clientMetadata() {
    return {
      redirect_uris: ["http://localhost/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"] as string[],
      response_types: ["code"] as string[],
      token_endpoint_auth_method: "none" as const,
      client_name: "Executor",
    };
  },
  clientInformation: () => undefined,
  saveClientInformation: () => {},
  tokens: async (): Promise<OAuthTokens> => ({
    access_token: accessToken,
    token_type: tokenType,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  }),
  saveTokens: async () => {},
  redirectToAuthorization: async () => {
    throw new Error("MCP OAuth re-authorization required");
  },
  saveCodeVerifier: () => {},
  codeVerifier: () => { throw new Error("No active PKCE verifier"); },
  saveDiscoveryState: () => {},
  discoveryState: () => undefined,
});

// ---------------------------------------------------------------------------
// Elicitation bridge
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
    requestedSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
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
  toolId: ToolId,
  args: unknown,
  handler: ElicitationHandler,
): void => {
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request: { params: unknown }) => {
      const params = decodeElicitParams(request.params);
      const response = await Effect.runPromise(
        handler({ toolId, args, request: toElicitationRequest(params) }),
      );
      return {
        action: response.action,
        ...(response.action === "accept" && response.content
          ? { content: response.content }
          : {}),
      };
    },
  );
};

// ---------------------------------------------------------------------------
// Resolve ConnectorInput from stored source data
// ---------------------------------------------------------------------------

const resolveConnectorInput = (
  sourceData: McpStoredSourceData,
  secrets: Secrets,
  scopeId: ScopeId,
): Effect.Effect<ConnectorInput, ToolInvocationError> => {
  if (sourceData.transport === "stdio") {
    return Effect.succeed({
      transport: "stdio" as const,
      command: sourceData.command,
      args: sourceData.args,
      env: sourceData.env,
      cwd: sourceData.cwd,
    });
  }

  return Effect.gen(function* () {
    const headers: Record<string, string> = { ...(sourceData.headers ?? {}) };
    let authProvider: OAuthClientProvider | undefined;

    const auth = sourceData.auth;
    if (auth.kind === "header") {
      const secretValue = yield* secrets
        .resolve(auth.secretId as SecretId, scopeId)
        .pipe(
          Effect.mapError(
            () =>
              new ToolInvocationError({
                toolId: "" as ToolId,
                message: `Failed to resolve secret "${auth.secretId}" for MCP auth`,
                cause: undefined,
              }),
          ),
        );
      headers[auth.headerName] = auth.prefix
        ? `${auth.prefix}${secretValue}`
        : secretValue;
    } else if (auth.kind === "oauth2") {
      const accessToken = yield* secrets
        .resolve(auth.accessTokenSecretId as SecretId, scopeId)
        .pipe(
          Effect.mapError(
            () =>
              new ToolInvocationError({
                toolId: "" as ToolId,
                message: "Failed to resolve OAuth access token for MCP auth",
                cause: undefined,
              }),
          ),
        );

      let refreshToken: string | undefined;
      if (auth.refreshTokenSecretId) {
        refreshToken = yield* secrets
          .resolve(auth.refreshTokenSecretId as SecretId, scopeId)
          .pipe(
            Effect.option,
            Effect.map((o) => o._tag === "Some" ? o.value : undefined),
          );
      }

      authProvider = makeOAuthProvider(
        accessToken,
        auth.tokenType ?? "Bearer",
        refreshToken,
      );
    }

    return {
      transport: "remote" as const,
      endpoint: sourceData.endpoint,
      remoteTransport: sourceData.remoteTransport,
      queryParams: sourceData.queryParams,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      authProvider,
    };
  });
};

// ---------------------------------------------------------------------------
// Connection cache key
// ---------------------------------------------------------------------------

const connectionCacheKey = (sourceData: McpStoredSourceData): string =>
  sourceData.transport === "stdio"
    ? `stdio:${sourceData.command}`
    : `remote:${sourceData.endpoint}`;

// ---------------------------------------------------------------------------
// Resolve elicitation handler from options
// ---------------------------------------------------------------------------

const resolveElicitationHandler = (
  options: InvokeOptions,
): ElicitationHandler =>
  options.onElicitation === "accept-all"
    ? () => Effect.succeed(new ElicitationResponse({ action: "accept" }))
    : options.onElicitation;

// ---------------------------------------------------------------------------
// Use pattern — wrap MCP Client as an Effect service
// ---------------------------------------------------------------------------

const useMcpConnection = (
  connection: McpConnection,
  toolId: ToolId,
  toolName: string,
  args: Record<string, unknown>,
  handler: ElicitationHandler,
): Effect.Effect<unknown, ToolInvocationError> =>
  Effect.gen(function* () {
    installElicitationHandler(connection.client, toolId, args, handler);

    return yield* Effect.tryPromise({
      try: () =>
        connection.client.callTool({ name: toolName, arguments: args }),
      catch: (cause) =>
        new ToolInvocationError({
          toolId,
          message: `MCP tool call failed for ${toolName}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });
  }).pipe(Effect.withSpan(`mcp.callTool.${toolName}`));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const makeMcpInvoker = (opts: {
  readonly bindingStore: McpBindingStore;
  readonly secrets: Secrets;
  readonly scopeId: ScopeId;
  readonly connectionCache: ScopedCache.ScopedCache<string, McpConnection, McpConnectionError>;
  /** Shared map between cache lookup and invoker — set connector before cache.get */
  readonly pendingConnectors: Map<string, Effect.Effect<McpConnection, McpConnectionError>>;
}): ToolInvoker & { readonly closeConnections: () => Effect.Effect<void> } => {
  const { connectionCache, pendingConnectors } = opts;

  return {
    resolveAnnotations: () =>
      Effect.succeed(
        new ToolAnnotations({ requiresApproval: false }),
      ),

    invoke: (toolId: ToolId, args: unknown, options: InvokeOptions) =>
      Effect.gen(function* () {
        const entry = yield* opts.bindingStore.get(toolId);
        if (!entry) {
          return yield* new ToolInvocationError({
            toolId,
            message: `No MCP binding found for tool "${toolId}"`,
            cause: undefined,
          });
        }

        const { binding, sourceData } = entry;
        const cacheKey = connectionCacheKey(sourceData);

        // Build the connector and register it for the cache lookup
        const connector = resolveConnectorInput(
          sourceData,
          opts.secrets,
          opts.scopeId,
        ).pipe(
          Effect.flatMap((ci) => createMcpConnector(ci)),
          Effect.mapError(
            (err) =>
              new McpConnectionError({
                transport: "auto",
                message: err instanceof Error ? err.message : String(err),
              }),
          ),
        );
        pendingConnectors.set(cacheKey, connector);

        const connection = yield* connectionCache.get(cacheKey).pipe(
          Effect.mapError(
            (err) =>
              new ToolInvocationError({
                toolId,
                message: `Failed connecting to MCP server: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                cause: err,
              }),
          ),
        );

        const elicitationHandler = resolveElicitationHandler(options);

        return yield* useMcpConnection(
          connection,
          toolId,
          binding.toolName,
          asRecord(args),
          elicitationHandler,
        ).pipe(
          // On failure, invalidate the cached connection and retry once
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              yield* connectionCache.invalidate(cacheKey);
              pendingConnectors.set(cacheKey, connector);

              const freshConnection = yield* connectionCache
                .get(cacheKey)
                .pipe(
                  Effect.mapError(
                    (retryErr) =>
                      new ToolInvocationError({
                        toolId,
                        message: `Failed reconnecting: ${
                          retryErr instanceof Error
                            ? retryErr.message
                            : String(retryErr)
                        }`,
                        cause: retryErr,
                      }),
                  ),
                );

              return yield* useMcpConnection(
                freshConnection,
                toolId,
                binding.toolName,
                asRecord(args),
                elicitationHandler,
              );
            }),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.map((callResult) => {
          const resultRecord = asRecord(callResult);
          const isError = resultRecord.isError === true;
          return new ToolInvocationResult({
            data: isError ? null : (callResult ?? null),
            error: isError ? callResult : null,
          });
        }),
        Effect.catchAll((err) => {
          if (
            typeof err === "object" &&
            err !== null &&
            "_tag" in err &&
            (err as { _tag: string })._tag === "ToolInvocationError"
          ) {
            return Effect.fail(err as ToolInvocationError);
          }
          return Effect.fail(
            new ToolInvocationError({
              toolId,
              message: `MCP invocation failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              cause: err,
            }),
          );
        }),
      ),

    closeConnections: () =>
      Effect.sync(() => {
        pendingConnectors.clear();
      }).pipe(
        Effect.flatMap(() => connectionCache.invalidateAll),
      ),
  };
};
