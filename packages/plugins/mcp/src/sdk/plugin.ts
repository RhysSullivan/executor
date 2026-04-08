import { Effect, Exit, ScopedCache, Duration, Scope } from "effect";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  Source,
  SourceDetectionResult,
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  ToolId,
  SecretId,
  type ToolRegistration,
} from "@executor/core";

import {
  type McpStoredSourceData,
  type McpConnectionAuth,
  McpToolBinding,
} from "./types";
import {
  makeInMemoryBindingStore,
  type McpBindingStore,
} from "./binding-store";
import {
  createMcpConnector,
  type McpConnection,
  type ConnectorInput,
} from "./connection";
import {
  McpConnectionError,
  McpOAuthError,
  McpToolDiscoveryError,
} from "./errors";
import {
  startMcpOAuthAuthorization,
  exchangeMcpOAuthCode,
  type McpOAuthSession,
} from "./oauth";
import { discoverTools } from "./discover";
import { makeMcpInvoker } from "./invoke";
import {
  deriveMcpNamespace,
  joinToolPath,
  type McpToolManifestEntry,
} from "./manifest";

// ---------------------------------------------------------------------------
// Plugin config — discriminated union on transport
// ---------------------------------------------------------------------------

export interface McpRemoteSourceConfig {
  readonly transport: "remote";
  readonly name: string;
  readonly endpoint: string;
  readonly remoteTransport?: "streamable-http" | "sse" | "auto";
  readonly queryParams?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly namespace?: string;
  readonly auth?: McpConnectionAuth;
}

export interface McpStdioSourceConfig {
  readonly transport: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly namespace?: string;
}

export type McpSourceConfig = McpRemoteSourceConfig | McpStdioSourceConfig;

// ---------------------------------------------------------------------------
// Plugin extension types
// ---------------------------------------------------------------------------

export interface McpOAuthStartInput {
  readonly endpoint: string;
  readonly redirectUrl: string;
  readonly queryParams?: Record<string, string> | null;
}

export interface McpOAuthStartResponse {
  readonly sessionId: string;
  readonly authorizationUrl: string;
}

export interface McpOAuthCompleteInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

export interface McpOAuthCompleteResponse {
  readonly accessTokenSecretId: string;
  readonly refreshTokenSecretId: string | null;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
}

export interface McpProbeResult {
  readonly connected: boolean;
  readonly requiresOAuth: boolean;
  readonly name: string;
  readonly namespace: string;
  readonly toolCount: number | null;
  readonly serverName: string | null;
}

export interface McpPluginExtension {
  readonly probeEndpoint: (
    endpoint: string,
  ) => Effect.Effect<McpProbeResult, Error>;

  readonly addSource: (
    config: McpSourceConfig,
  ) => Effect.Effect<
    { readonly toolCount: number; readonly namespace: string },
    Error
  >;

  readonly removeSource: (namespace: string) => Effect.Effect<void>;

  readonly refreshSource: (
    namespace: string,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;

  readonly startOAuth: (
    input: McpOAuthStartInput,
  ) => Effect.Effect<McpOAuthStartResponse, Error>;

  readonly completeOAuth: (
    input: McpOAuthCompleteInput,
  ) => Effect.Effect<McpOAuthCompleteResponse, Error>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toRegistration = (
  entry: McpToolManifestEntry,
  namespace: string,
): ToolRegistration => ({
  id: ToolId.make(joinToolPath(namespace, entry.toolId)),
  pluginKey: "mcp",
  sourceId: namespace,
  name: entry.toolName,
  description: entry.description ?? `MCP tool: ${entry.toolName}`,
  inputSchema: entry.inputSchema,
  outputSchema: entry.outputSchema,
});

const toBinding = (entry: McpToolManifestEntry): McpToolBinding =>
  new McpToolBinding({
    toolId: entry.toolId,
    toolName: entry.toolName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
  });

const toStoredSourceData = (config: McpSourceConfig): McpStoredSourceData => {
  if (config.transport === "stdio") {
    return {
      transport: "stdio",
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    };
  }
  return {
    transport: "remote",
    endpoint: config.endpoint,
    remoteTransport: config.remoteTransport ?? "auto",
    queryParams: config.queryParams,
    headers: config.headers,
    auth: config.auth ?? { kind: "none" },
  };
};

const normalizeNamespace = (config: McpSourceConfig): string =>
  config.namespace ??
  deriveMcpNamespace({
    name: config.name,
    endpoint: config.transport === "remote" ? config.endpoint : undefined,
    command: config.transport === "stdio" ? config.command : undefined,
  });

const makeOAuthProvider = (
  accessToken: string,
  tokenType: string,
  refreshToken?: string,
): OAuthClientProvider => ({
  get redirectUrl() {
    return "http://localhost/oauth/callback";
  },
  get clientMetadata() {
    return {
      redirect_uris: ["http://localhost/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
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
  codeVerifier: () => {
    throw new Error("No active PKCE verifier");
  },
  saveDiscoveryState: () => {},
  discoveryState: () => undefined,
});

const remoteConnectionError = (message: string) =>
  new McpConnectionError({ transport: "remote", message });

const mcpOAuthError = (message: string) => new McpOAuthError({ message });

const mcpDiscoveryError = (message: string) =>
  new McpToolDiscoveryError({ stage: "list_tools", message });

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const mcpPlugin = (options?: {
  readonly bindingStore?: McpBindingStore;
}): ExecutorPlugin<"mcp", McpPluginExtension> => {
  const bindingStore = options?.bindingStore ?? makeInMemoryBindingStore();
  const addedSources = new Map<string, Source>();
  const oauthSessions = new Map<string, McpOAuthSession>();

  return definePlugin({
    key: "mcp",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        // Create a long-lived scope for the connection cache
        const cacheScope = yield* Scope.make();

        // Side-channel for deferred connector lookup (populated before
        // each cache.get call so the lookup knows how to connect)
        const pendingConnectors = new Map<
          string,
          Effect.Effect<McpConnection, McpConnectionError>
        >();

        // ScopedCache: keyed by source identity, acquireRelease manages
        // connection lifecycle, TTL evicts idle connections.
        const connectionCache = yield* ScopedCache.make({
          lookup: (key: string) =>
            Effect.acquireRelease(
              Effect.suspend(() => {
                const connector = pendingConnectors.get(key);
                if (!connector) {
                  return Effect.fail(
                    new McpConnectionError({
                      transport: "auto",
                      message: `No pending connector for key: ${key}`,
                    }),
                  );
                }
                return connector;
              }),
              (connection) =>
                Effect.promise(() => connection.close().catch(() => {})),
            ),
          capacity: 64,
          timeToLive: Duration.minutes(5),
        }).pipe(Scope.extend(cacheScope));

        const invoker = makeMcpInvoker({
          bindingStore,
          secrets: ctx.secrets,
          scopeId: ctx.scope.id,
          connectionCache,
          pendingConnectors,
        });
        yield* ctx.tools.registerInvoker("mcp", invoker);

        // Restore source metadata
        const savedSources = yield* bindingStore.listSources();
        for (const s of savedSources) {
          addedSources.set(
            s.namespace,
            new Source({ id: s.namespace, name: s.name, kind: "mcp" }),
          );
        }

        // ----- Shared: resolve ConnectorInput from stored data -----

        const resolveConnectorInput = (
          sd: McpStoredSourceData,
        ): Effect.Effect<ConnectorInput, Error> => {
          if (sd.transport === "stdio") {
            return Effect.succeed({
              transport: "stdio" as const,
              command: sd.command,
              args: sd.args,
              env: sd.env,
              cwd: sd.cwd,
            });
          }

          return Effect.gen(function* () {
            const headers: Record<string, string> = {
              ...(sd.headers ?? {}),
            };
            let authProvider: OAuthClientProvider | undefined;

            const auth = sd.auth;
            if (auth.kind === "header") {
              const val = yield* ctx.secrets
                .resolve(auth.secretId as any, ctx.scope.id)
                .pipe(
                  Effect.mapError(
                    () =>
                      remoteConnectionError(
                        `Failed to resolve secret "${auth.secretId}"`,
                      ),
                  ),
                );
              headers[auth.headerName] = auth.prefix
                ? `${auth.prefix}${val}`
                : val;
            } else if (auth.kind === "oauth2") {
              const accessToken = yield* ctx.secrets
                .resolve(auth.accessTokenSecretId as any, ctx.scope.id)
                .pipe(
                  Effect.mapError(
                    () =>
                      remoteConnectionError(
                        "Failed to resolve OAuth access token",
                      ),
                  ),
                );

              let refreshToken: string | undefined;
              if (auth.refreshTokenSecretId) {
                refreshToken = yield* ctx.secrets
                  .resolve(auth.refreshTokenSecretId as any, ctx.scope.id)
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
              endpoint: sd.endpoint,
              remoteTransport: sd.remoteTransport,
              queryParams: sd.queryParams,
              headers:
                Object.keys(headers).length > 0 ? headers : undefined,
              authProvider,
            };
          });
        };

        // ----- Source manager -----

        yield* ctx.sources.addManager({
          kind: "mcp",

          list: () => Effect.sync(() => [...addedSources.values()]),

          remove: (sourceId: string) =>
            Effect.gen(function* () {
              yield* bindingStore.removeByNamespace(sourceId);
              yield* bindingStore.removeSource(sourceId);
              yield* ctx.tools.unregisterBySource(sourceId);
              addedSources.delete(sourceId);
            }),

          detect: (url: string) =>
            Effect.gen(function* () {
              const trimmed = url.trim();
              if (!trimmed) return null;
              const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(
                Effect.option,
              );
              if (parsed._tag === "None") return null;

              const name = parsed.value.hostname || "mcp";
              const namespace = deriveMcpNamespace({ endpoint: trimmed });

              const connector = createMcpConnector({
                transport: "remote",
                endpoint: trimmed,
              });

              const connected = yield* discoverTools(connector).pipe(
                Effect.map(() => true),
                Effect.catchAll(() => Effect.succeed(false)),
              );

              if (connected) {
                return new SourceDetectionResult({
                  kind: "mcp",
                  confidence: "high",
                  endpoint: trimmed,
                  name,
                  namespace,
                });
              }

              // Probe for OAuth — still means it's an MCP server
              const hasOAuth = yield* startMcpOAuthAuthorization({
                endpoint: trimmed,
                redirectUrl: "http://127.0.0.1/executor/discovery/oauth/probe",
                state: "probe",
              }).pipe(
                Effect.map(() => true),
                Effect.catchAll(() => Effect.succeed(false)),
              );

              if (hasOAuth) {
                return new SourceDetectionResult({
                  kind: "mcp",
                  confidence: "high",
                  endpoint: trimmed,
                  name,
                  namespace,
                });
              }

              return null;
            }),

          refresh: (sourceId: string) =>
            Effect.gen(function* () {
              const sd = yield* bindingStore.getSourceConfig(sourceId);
              if (!sd || !addedSources.has(sourceId)) return;

              const ci = yield* resolveConnectorInput(sd).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              );
              if (!ci) return;

              const manifest = yield* discoverTools(
                createMcpConnector(ci),
              ).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!manifest) return;

              const oldIds =
                yield* bindingStore.removeByNamespace(sourceId);
              if (oldIds.length > 0) yield* ctx.tools.unregister(oldIds);

              yield* Effect.forEach(
                manifest.tools,
                (e) =>
                  bindingStore.put(
                    ToolId.make(joinToolPath(sourceId, e.toolId)),
                    sourceId,
                    toBinding(e),
                    sd,
                  ),
                { discard: true },
              );
              yield* ctx.tools.register(
                manifest.tools.map((e) => toRegistration(e, sourceId)),
              );
            }),
        });

        // ----- Extension methods -----

        const probeEndpoint = (endpoint: string) =>
          Effect.gen(function* () {
            const trimmed = endpoint.trim();
            if (!trimmed)
              return yield* remoteConnectionError("Endpoint URL is required");

            const name = yield* Effect.try(() => new URL(trimmed).hostname).pipe(
              Effect.orElseSucceed(() => "mcp"),
            );
            const namespace = deriveMcpNamespace({ endpoint: trimmed });

            // Try connecting directly
            const connector = createMcpConnector({
              transport: "remote",
              endpoint: trimmed,
            });

            const result = yield* discoverTools(connector).pipe(
              Effect.map((m) => ({ ok: true as const, manifest: m })),
              Effect.catchAll(() =>
                Effect.succeed({ ok: false as const, manifest: null }),
              ),
            );

            if (result.ok && result.manifest) {
              return {
                connected: true,
                requiresOAuth: false,
                name: result.manifest.server?.name ?? name,
                namespace,
                toolCount: result.manifest.tools.length,
                serverName: result.manifest.server?.name ?? null,
              } satisfies McpProbeResult;
            }

            // Probe for OAuth
            const hasOAuth = yield* startMcpOAuthAuthorization({
              endpoint: trimmed,
              redirectUrl:
                "http://127.0.0.1/executor/discovery/oauth/probe",
              state: "probe",
            }).pipe(
              Effect.map(() => true),
              Effect.catchAll(() => Effect.succeed(false)),
            );

            if (hasOAuth) {
              return {
                connected: false,
                requiresOAuth: true,
                name,
                namespace,
                toolCount: null,
                serverName: null,
              } satisfies McpProbeResult;
            }

            return yield* remoteConnectionError(
              "Could not connect to MCP endpoint and no OAuth was detected",
            );
          });

        const addSource = (config: McpSourceConfig) =>
          Effect.gen(function* () {
            const namespace = normalizeNamespace(config);
            const sd = toStoredSourceData(config);
            const ci = yield* resolveConnectorInput(sd);
            const connector = createMcpConnector(ci);

            const manifest = yield* discoverTools(connector).pipe(
              Effect.mapError((err) =>
                mcpDiscoveryError(`MCP discovery failed: ${err.message}`),
              ),
            );

            const registrations = manifest.tools.map((e) =>
              toRegistration(e, namespace),
            );

            yield* Effect.forEach(
              manifest.tools,
              (e) =>
                bindingStore.put(
                  ToolId.make(joinToolPath(namespace, e.toolId)),
                  namespace,
                  toBinding(e),
                  sd,
                ),
              { discard: true },
            );

            yield* ctx.tools.register(registrations);

            const sourceName =
              manifest.server?.name ?? config.name ?? namespace;
            yield* bindingStore.putSource({
              namespace,
              name: sourceName,
              config: sd,
            });

            addedSources.set(
              namespace,
              new Source({
                id: namespace,
                name: sourceName,
                kind: "mcp",
              }),
            );

            return { toolCount: registrations.length, namespace };
          });

        const removeSource = (namespace: string) =>
          Effect.gen(function* () {
            const ids = yield* bindingStore.removeByNamespace(namespace);
            if (ids.length > 0) yield* ctx.tools.unregister(ids);
            yield* bindingStore.removeSource(namespace);
            addedSources.delete(namespace);
          });

        const refreshSource = (namespace: string) =>
          Effect.gen(function* () {
            const sd = yield* bindingStore.getSourceConfig(namespace);
            if (!sd)
              return yield* remoteConnectionError(
                `No stored config for MCP source "${namespace}"`,
              );

            const ci = yield* resolveConnectorInput(sd);
            const manifest = yield* discoverTools(
              createMcpConnector(ci),
            ).pipe(
              Effect.mapError((err) =>
                mcpDiscoveryError(`MCP refresh failed: ${err.message}`),
              ),
            );

            const oldIds =
              yield* bindingStore.removeByNamespace(namespace);
            if (oldIds.length > 0) yield* ctx.tools.unregister(oldIds);

            yield* Effect.forEach(
              manifest.tools,
              (e) =>
                bindingStore.put(
                  ToolId.make(joinToolPath(namespace, e.toolId)),
                  namespace,
                  toBinding(e),
                  sd,
                ),
              { discard: true },
            );
            yield* ctx.tools.register(
              manifest.tools.map((e) => toRegistration(e, namespace)),
            );

            return { toolCount: manifest.tools.length };
          });

        const startOAuth = (input: McpOAuthStartInput) =>
          Effect.gen(function* () {
            const endpoint = input.endpoint.trim();
            if (!endpoint)
              return yield* mcpOAuthError("MCP OAuth requires an endpoint");

            let fullEndpoint = endpoint;
            if (
              input.queryParams &&
              Object.keys(input.queryParams).length > 0
            ) {
              const u = new URL(endpoint);
              for (const [k, v] of Object.entries(input.queryParams))
                u.searchParams.set(k, v);
              fullEndpoint = u.toString();
            }

            const sessionId = `mcp_oauth_${crypto.randomUUID()}`;
            const started = yield* startMcpOAuthAuthorization({
              endpoint: fullEndpoint,
              redirectUrl: input.redirectUrl,
              state: sessionId,
            }).pipe(
              Effect.mapError((e) =>
                mcpOAuthError(`OAuth start failed: ${e.message}`),
              ),
            );

            oauthSessions.set(sessionId, {
              endpoint: fullEndpoint,
              redirectUrl: input.redirectUrl,
              codeVerifier: started.codeVerifier,
              resourceMetadataUrl: started.resourceMetadataUrl,
              authorizationServerUrl: started.authorizationServerUrl,
              resourceMetadata: started.resourceMetadata,
              authorizationServerMetadata:
                started.authorizationServerMetadata,
              clientInformation: started.clientInformation,
            });

            return {
              sessionId,
              authorizationUrl: started.authorizationUrl,
            };
          });

        const completeOAuth = (input: McpOAuthCompleteInput) =>
          Effect.gen(function* () {
            if (input.error)
              return yield* mcpOAuthError(`OAuth error: ${input.error}`);
            if (!input.code)
              return yield* mcpOAuthError("Missing OAuth authorization code");

            const session = oauthSessions.get(input.state);
            if (!session)
              return yield* mcpOAuthError(`OAuth session not found: ${input.state}`);

            const exchanged = yield* exchangeMcpOAuthCode({
              session,
              code: input.code,
            }).pipe(
              Effect.mapError((e) =>
                mcpOAuthError(`OAuth exchange failed: ${e.message}`),
              ),
            );

            const accessTokenRef = yield* ctx.secrets
              .set({
                id: SecretId.make(
                  `mcp-oauth-access-${input.state}`,
                ),
                scopeId: ctx.scope.id,
                name: "MCP OAuth Access Token",
                value: exchanged.tokens.access_token,
                purpose: "oauth_access_token",
              })
              .pipe(
                Effect.mapError((e) =>
                  mcpOAuthError(
                    `Failed to store access token: ${String(e)}`,
                  ),
                ),
              );

            let refreshTokenSecretId: string | null = null;
            if (exchanged.tokens.refresh_token) {
              const ref = yield* ctx.secrets
                .set({
                  id: SecretId.make(
                    `mcp-oauth-refresh-${input.state}`,
                  ),
                  scopeId: ctx.scope.id,
                  name: "MCP OAuth Refresh Token",
                  value: exchanged.tokens.refresh_token,
                  purpose: "oauth_refresh_token",
                })
                .pipe(
                  Effect.mapError((e) =>
                    mcpOAuthError(
                      `Failed to store refresh token: ${String(e)}`,
                    ),
                  ),
                );
              refreshTokenSecretId = ref.id;
            }

            oauthSessions.delete(input.state);

            const expiresAt =
              typeof exchanged.tokens.expires_in === "number"
                ? Date.now() + exchanged.tokens.expires_in * 1000
                : null;

            return {
              accessTokenSecretId: accessTokenRef.id,
              refreshTokenSecretId,
              tokenType: exchanged.tokens.token_type ?? "Bearer",
              expiresAt,
              scope: exchanged.tokens.scope ?? null,
            };
          });

        return {
          extension: {
            probeEndpoint,
            addSource,
            removeSource,
            refreshSource,
            startOAuth,
            completeOAuth,
          },

          close: () =>
            Effect.gen(function* () {
              yield* invoker.closeConnections();
              yield* Scope.close(cacheScope, Exit.void);
              for (const sourceId of addedSources.keys()) {
                yield* ctx.tools.unregisterBySource(sourceId);
              }
              addedSources.clear();
            }),
        };
      }),
  });
};
