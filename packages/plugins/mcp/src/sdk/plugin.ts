import { Duration, Effect, Exit, Scope, ScopedCache } from "effect";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  definePlugin,
  SecretId,
  SetSecretInput,
  SourceDetectionResult,
  type PluginCtx,
} from "@executor/sdk";

import {
  makeMcpStore,
  mcpSchema,
  type McpBindingStore,
  type McpStoredSource,
} from "./binding-store";
import {
  createMcpConnector,
  type ConnectorInput,
  type McpConnection,
} from "./connection";
import { discoverTools } from "./discover";
import {
  McpConnectionError,
  McpOAuthError,
  McpToolDiscoveryError,
} from "./errors";
import { invokeMcpTool } from "./invoke";
import {
  deriveMcpNamespace,
  type McpToolManifestEntry,
} from "./manifest";
import { exchangeMcpOAuthCode, startMcpOAuthAuthorization } from "./oauth";
import { McpToolBinding, type McpConnectionAuth, type McpStoredSourceData } from "./types";

import {
  SECRET_REF_PREFIX,
  type ConfigFileSink,
  type McpAuthConfig,
  type McpRemoteSourceConfig as McpRemoteConfigEntry,
  type McpStdioSourceConfig as McpStdioConfigEntry,
  type SourceConfig,
} from "@executor/config";

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
// Extension types
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

export interface McpUpdateSourceInput {
  readonly name?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
  readonly auth?: McpConnectionAuth;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const toBinding = (entry: McpToolManifestEntry): McpToolBinding =>
  new McpToolBinding({
    toolId: entry.toolId,
    toolName: entry.toolName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
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
// Shared connector resolution — reads secrets, builds stdio/remote input
// ---------------------------------------------------------------------------

const resolveConnectorInput = (
  sd: McpStoredSourceData,
  ctx: PluginCtx<McpBindingStore>,
  allowStdio: boolean,
): Effect.Effect<ConnectorInput, Error> => {
  if (sd.transport === "stdio") {
    if (!allowStdio) {
      return Effect.fail(
        new McpConnectionError({
          transport: "stdio",
          message:
            "MCP stdio transport is disabled. Enable it by passing `dangerouslyAllowStdioMCP: true` to mcpPlugin() — only safe for trusted local contexts.",
        }),
      );
    }
    return Effect.succeed({
      transport: "stdio" as const,
      command: sd.command,
      args: sd.args,
      env: sd.env,
      cwd: sd.cwd,
    });
  }

  return Effect.gen(function* () {
    const headers: Record<string, string> = { ...sd.headers };
    let authProvider: OAuthClientProvider | undefined;

    const auth = sd.auth;
    if (auth.kind === "header") {
      const val = yield* ctx.secrets.get(auth.secretId);
      if (val === null) {
        return yield* Effect.fail(
          remoteConnectionError(`Failed to resolve secret "${auth.secretId}"`),
        );
      }
      headers[auth.headerName] = auth.prefix ? `${auth.prefix}${val}` : val;
    } else if (auth.kind === "oauth2") {
      const accessToken = yield* ctx.secrets.get(auth.accessTokenSecretId);
      if (accessToken === null) {
        return yield* Effect.fail(
          remoteConnectionError("Failed to resolve OAuth access token"),
        );
      }
      const refreshToken = auth.refreshTokenSecretId
        ? (yield* ctx.secrets.get(auth.refreshTokenSecretId)) ?? undefined
        : undefined;
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
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      authProvider,
    };
  });
};

// ---------------------------------------------------------------------------
// Connection cache — kept as plugin-module state so both invokeTool and
// the close hook see the same ScopedCache instance. The ScopedCache's
// lookup key is the stringified stored source data identity.
// ---------------------------------------------------------------------------

interface McpRuntime {
  readonly connectionCache: ScopedCache.ScopedCache<
    string,
    McpConnection,
    McpConnectionError
  >;
  readonly pendingConnectors: Map<
    string,
    Effect.Effect<McpConnection, McpConnectionError>
  >;
  readonly cacheScope: Scope.CloseableScope;
}

const makeRuntime = (): Effect.Effect<McpRuntime, Error> =>
  Effect.gen(function* () {
    const cacheScope = yield* Scope.make();
    const pendingConnectors = new Map<
      string,
      Effect.Effect<McpConnection, McpConnectionError>
    >();
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

    return { connectionCache, pendingConnectors, cacheScope };
  });

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface McpPluginOptions {
  /**
   * Allow configuring stdio-transport MCP sources. Off by default.
   *
   * Stdio sources spawn a local subprocess that inherits the parent
   * `process.env`. Only enable for trusted single-user contexts.
   */
  readonly dangerouslyAllowStdioMCP?: boolean;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
}

const secretRef = (id: string): string => `${SECRET_REF_PREFIX}${id}`;

const authToConfig = (auth: McpConnectionAuth | undefined): McpAuthConfig | undefined => {
  if (!auth) return undefined;
  if (auth.kind === "none") return { kind: "none" };
  if (auth.kind === "header") {
    return {
      kind: "header",
      headerName: auth.headerName,
      secret: secretRef(auth.secretId),
      prefix: auth.prefix,
    };
  }
  return {
    kind: "oauth2",
    accessTokenSecret: secretRef(auth.accessTokenSecretId),
    refreshTokenSecret: auth.refreshTokenSecretId
      ? secretRef(auth.refreshTokenSecretId)
      : null,
    tokenType: auth.tokenType,
  };
};

const toMcpConfigEntry = (
  namespace: string,
  sourceName: string,
  config: McpSourceConfig,
): SourceConfig => {
  if (config.transport === "stdio") {
    const entry: McpStdioConfigEntry = {
      kind: "mcp",
      transport: "stdio",
      name: sourceName,
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      namespace,
    };
    return entry;
  }
  const entry: McpRemoteConfigEntry = {
    kind: "mcp",
    transport: "remote",
    name: sourceName,
    endpoint: config.endpoint,
    remoteTransport: config.remoteTransport,
    queryParams: config.queryParams,
    headers: config.headers,
    namespace,
    auth: authToConfig(config.auth),
  };
  return entry;
};

export const mcpPlugin = definePlugin(
  (options?: McpPluginOptions) => {
    const allowStdio = options?.dangerouslyAllowStdioMCP ?? false;
    // Per-plugin-instance runtime holder. Captured by closures in
    // `extension`, `invokeTool`, and `close`, so all three see the same
    // connection cache across a single createExecutor lifecycle.
    const runtimeRef: { current: McpRuntime | null } = { current: null };

    const ensureRuntime = (): Effect.Effect<McpRuntime, Error> =>
      runtimeRef.current
        ? Effect.succeed(runtimeRef.current)
        : makeRuntime().pipe(
            Effect.tap((rt) =>
              Effect.sync(() => {
                runtimeRef.current = rt;
              }),
            ),
          );

    return {
      id: "mcp" as const,
      schema: mcpSchema,
      storage: (deps): McpBindingStore => makeMcpStore(deps),

      extension: (ctx) => {
        const probeEndpoint = (endpoint: string) =>
          Effect.gen(function* () {
            const trimmed = endpoint.trim();
            if (!trimmed) {
              return yield* Effect.fail(
                remoteConnectionError("Endpoint URL is required"),
              );
            }

            const name = yield* Effect.try(
              () => new URL(trimmed).hostname,
            ).pipe(Effect.orElseSucceed(() => "mcp"));
            const namespace = deriveMcpNamespace({ endpoint: trimmed });

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

            const hasOAuth = yield* startMcpOAuthAuthorization({
              endpoint: trimmed,
              redirectUrl: "http://127.0.0.1/executor/discovery/oauth/probe",
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

            return yield* Effect.fail(
              remoteConnectionError(
                "Could not connect to MCP endpoint and no OAuth was detected",
              ),
            );
          });

        const configFile = options?.configFile;

        const addSource = (config: McpSourceConfig) =>
          Effect.gen(function* () {
            const namespace = normalizeNamespace(config);
            const sd = toStoredSourceData(config);

            // Resolve auth (may fail if stdio gate is off)
            const ci = yield* resolveConnectorInput(sd, ctx, allowStdio);

            const connector = createMcpConnector(ci);
            // Try discovery. If it fails (auth, network, bad spec), we still
            // want the source to land in the catalog so users see it in
            // their list and can retry via refresh. The error still
            // propagates to the caller so boot-time sync logs the reason.
            const discovery = yield* discoverTools(connector).pipe(
              Effect.mapError((err) =>
                mcpDiscoveryError(`MCP discovery failed: ${err.message}`),
              ),
              Effect.either,
            );
            const manifest =
              discovery._tag === "Right"
                ? discovery.right
                : { server: undefined, tools: [] as const };

            const sourceName = manifest.server?.name ?? config.name ?? namespace;

            yield* ctx.transaction(
              Effect.gen(function* () {
                // Remove stale rows for this namespace (plugin-owned)
                yield* ctx.storage.removeBindingsByNamespace(namespace);
                yield* ctx.storage.removeSource(namespace);

                yield* ctx.storage.putSource({
                  namespace,
                  name: sourceName,
                  config: sd,
                });

                yield* ctx.storage.putBindings(
                  namespace,
                  manifest.tools.map((e) => ({
                    toolId: `${namespace}.${e.toolId}`,
                    binding: toBinding(e),
                  })),
                );

                yield* ctx.core.sources.register({
                  id: namespace,
                  kind: "mcp",
                  name: sourceName,
                  url: sd.transport === "remote" ? sd.endpoint : undefined,
                  canRemove: true,
                  canRefresh: true,
                  canEdit: sd.transport === "remote",
                  tools: manifest.tools.map((e) => ({
                    name: e.toolId,
                    description: e.description ?? `MCP tool: ${e.toolName}`,
                    inputSchema: e.inputSchema,
                    outputSchema: e.outputSchema,
                  })),
                });
              }),
            );

            if (configFile) {
              yield* configFile.upsertSource(
                toMcpConfigEntry(namespace, sourceName, config),
              );
            }

            if (discovery._tag === "Left") {
              return yield* Effect.fail(discovery.left);
            }
            return { toolCount: manifest.tools.length, namespace };
          });

        const removeSource = (namespace: string) =>
          Effect.gen(function* () {
            yield* ctx.transaction(
              Effect.gen(function* () {
                yield* ctx.storage.removeBindingsByNamespace(namespace);
                yield* ctx.storage.removeSource(namespace);
                yield* ctx.core.sources.unregister(namespace);
              }),
            );
            if (configFile) {
              yield* configFile.removeSource(namespace);
            }
          });

        const refreshSource = (namespace: string) =>
          Effect.gen(function* () {
            const sd = yield* ctx.storage.getSourceConfig(namespace);
            if (!sd) {
              return yield* Effect.fail(
                remoteConnectionError(
                  `No stored config for MCP source "${namespace}"`,
                ),
              );
            }

            const ci = yield* resolveConnectorInput(sd, ctx, allowStdio);
            const manifest = yield* discoverTools(createMcpConnector(ci)).pipe(
              Effect.mapError((err) =>
                mcpDiscoveryError(`MCP refresh failed: ${err.message}`),
              ),
            );

            const existing = yield* ctx.storage.getSource(namespace);
            const sourceName =
              manifest.server?.name ?? existing?.name ?? namespace;

            yield* ctx.transaction(
              Effect.gen(function* () {
                yield* ctx.storage.removeBindingsByNamespace(namespace);
                yield* ctx.core.sources.unregister(namespace);

                yield* ctx.storage.putBindings(
                  namespace,
                  manifest.tools.map((e) => ({
                    toolId: `${namespace}.${e.toolId}`,
                    binding: toBinding(e),
                  })),
                );
                yield* ctx.core.sources.register({
                  id: namespace,
                  kind: "mcp",
                  name: sourceName,
                  url: sd.transport === "remote" ? sd.endpoint : undefined,
                  canRemove: true,
                  canRefresh: true,
                  canEdit: sd.transport === "remote",
                  tools: manifest.tools.map((e) => ({
                    name: e.toolId,
                    description: e.description ?? `MCP tool: ${e.toolName}`,
                    inputSchema: e.inputSchema,
                    outputSchema: e.outputSchema,
                  })),
                });
              }),
            );

            return { toolCount: manifest.tools.length };
          });

        const startOAuth = (input: McpOAuthStartInput) =>
          Effect.gen(function* () {
            const endpoint = input.endpoint.trim();
            if (!endpoint) {
              return yield* Effect.fail(
                mcpOAuthError("MCP OAuth requires an endpoint"),
              );
            }

            let fullEndpoint = endpoint;
            if (input.queryParams && Object.keys(input.queryParams).length > 0) {
              const u = new URL(endpoint);
              for (const [k, v] of Object.entries(input.queryParams)) {
                u.searchParams.set(k, v);
              }
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

            yield* ctx.storage.putOAuthSession(sessionId, {
              endpoint: fullEndpoint,
              redirectUrl: input.redirectUrl,
              codeVerifier: started.codeVerifier,
              resourceMetadataUrl: started.resourceMetadataUrl,
              authorizationServerUrl: started.authorizationServerUrl,
              resourceMetadata: started.resourceMetadata,
              authorizationServerMetadata: started.authorizationServerMetadata,
              clientInformation: started.clientInformation,
            });

            return {
              sessionId,
              authorizationUrl: started.authorizationUrl,
            };
          });

        const completeOAuth = (input: McpOAuthCompleteInput) =>
          Effect.gen(function* () {
            if (input.error) {
              return yield* Effect.fail(
                mcpOAuthError(`OAuth error: ${input.error}`),
              );
            }
            if (!input.code) {
              return yield* Effect.fail(
                mcpOAuthError("Missing OAuth authorization code"),
              );
            }

            const session = yield* ctx.storage.getOAuthSession(input.state);
            if (!session) {
              return yield* Effect.fail(
                mcpOAuthError(`OAuth session not found: ${input.state}`),
              );
            }

            const exchanged = yield* exchangeMcpOAuthCode({
              session,
              code: input.code,
            }).pipe(
              Effect.mapError((e) =>
                mcpOAuthError(`OAuth exchange failed: ${e.message}`),
              ),
            );

            const accessSecretId = `mcp-oauth-access-${input.state}`;
            yield* ctx.secrets
              .set(
                new SetSecretInput({
                  id: SecretId.make(accessSecretId),
                  name: "MCP OAuth Access Token",
                  value: exchanged.tokens.access_token,
                }),
              )
              .pipe(
                Effect.mapError((e) =>
                  mcpOAuthError(`Failed to store access token: ${String(e)}`),
                ),
              );

            let refreshTokenSecretId: string | null = null;
            if (exchanged.tokens.refresh_token) {
              const refreshId = `mcp-oauth-refresh-${input.state}`;
              yield* ctx.secrets
                .set(
                  new SetSecretInput({
                    id: SecretId.make(refreshId),
                    name: "MCP OAuth Refresh Token",
                    value: exchanged.tokens.refresh_token,
                  }),
                )
                .pipe(
                  Effect.mapError((e) =>
                    mcpOAuthError(
                      `Failed to store refresh token: ${String(e)}`,
                    ),
                  ),
                );
              refreshTokenSecretId = refreshId;
            }

            yield* ctx.storage.deleteOAuthSession(input.state);

            const expiresAt =
              typeof exchanged.tokens.expires_in === "number"
                ? Date.now() + exchanged.tokens.expires_in * 1000
                : null;

            return {
              accessTokenSecretId: accessSecretId,
              refreshTokenSecretId,
              tokenType: exchanged.tokens.token_type ?? "Bearer",
              expiresAt,
              scope: exchanged.tokens.scope ?? null,
            };
          });

        const updateSource = (
          namespace: string,
          input: McpUpdateSourceInput,
        ) =>
          Effect.gen(function* () {
            const existing = yield* ctx.storage.getSource(namespace);
            if (!existing || existing.config.transport !== "remote") return;

            const remote = existing.config;
            const updatedConfig: McpStoredSourceData = {
              ...remote,
              ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
              ...(input.headers !== undefined ? { headers: input.headers } : {}),
              ...(input.auth !== undefined ? { auth: input.auth } : {}),
              ...(input.queryParams !== undefined
                ? { queryParams: input.queryParams }
                : {}),
            };

            yield* ctx.storage.putSource({
              namespace,
              name: input.name?.trim() || existing.name,
              config: updatedConfig,
            });
          });

        const getSource = (namespace: string) =>
          ctx.storage.getSource(namespace);

        return {
          probeEndpoint,
          addSource,
          removeSource,
          refreshSource,
          startOAuth,
          completeOAuth,
          getSource,
          updateSource,
        };
      },

      invokeTool: ({ ctx, toolRow, args, elicit }) =>
        Effect.gen(function* () {
          const runtime = yield* ensureRuntime();

          const entry = yield* ctx.storage.getBinding(toolRow.id);
          if (!entry) {
            return yield* Effect.fail(
              new Error(`No MCP binding found for tool "${toolRow.id}"`),
            );
          }

          const sd = yield* ctx.storage.getSourceConfig(entry.namespace);
          if (!sd) {
            return yield* Effect.fail(
              new Error(
                `No MCP source config for namespace "${entry.namespace}"`,
              ),
            );
          }

          return yield* invokeMcpTool({
            toolId: toolRow.id,
            toolName: entry.binding.toolName,
            args,
            sourceData: sd,
            resolveConnector: () =>
              resolveConnectorInput(sd, ctx, allowStdio).pipe(
                Effect.flatMap((ci) => createMcpConnector(ci)),
                Effect.mapError((err) =>
                  err instanceof McpConnectionError
                    ? err
                    : new McpConnectionError({
                        transport: "auto",
                        message:
                          err instanceof Error ? err.message : String(err),
                      }),
                ),
              ),
            connectionCache: runtime.connectionCache,
            pendingConnectors: runtime.pendingConnectors,
            elicit,
          });
        }),

      detect: ({ url }) =>
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
        }).pipe(Effect.catchAll(() => Effect.succeed(null))),

      // MCP tools never require approval at the tool level — elicitation is
      // handled mid-invocation by the server via the elicit capability.
      resolveAnnotations: ({ toolRows }) =>
        Effect.sync(() => {
          const out: Record<string, { requiresApproval: boolean }> = {};
          for (const row of toolRows) {
            out[row.id] = { requiresApproval: false };
          }
          return out;
        }),

      removeSource: ({ ctx, sourceId }) =>
        Effect.gen(function* () {
          yield* ctx.storage.removeBindingsByNamespace(sourceId);
          yield* ctx.storage.removeSource(sourceId);
        }),

      refreshSource: () => Effect.void,

      close: () =>
        Effect.gen(function* () {
          const runtime = runtimeRef.current;
          if (runtime) {
            runtime.pendingConnectors.clear();
            yield* runtime.connectionCache.invalidateAll;
            yield* Scope.close(runtime.cacheScope, Exit.void);
            runtimeRef.current = null;
          }
        }),
    };
  },
);

// ---------------------------------------------------------------------------
// McpPluginExtension — shape of `executor.mcp` for consumers that want
// to type against it directly (api/, react/). Mirrors what `extension`
// returns above.
// ---------------------------------------------------------------------------

export interface McpPluginExtension {
  readonly probeEndpoint: (
    endpoint: string,
  ) => Effect.Effect<McpProbeResult, Error>;
  readonly addSource: (
    config: McpSourceConfig,
  ) => Effect.Effect<{ readonly toolCount: number; readonly namespace: string }, Error>;
  readonly removeSource: (namespace: string) => Effect.Effect<void, Error>;
  readonly refreshSource: (
    namespace: string,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;
  readonly startOAuth: (
    input: McpOAuthStartInput,
  ) => Effect.Effect<McpOAuthStartResponse, Error>;
  readonly completeOAuth: (
    input: McpOAuthCompleteInput,
  ) => Effect.Effect<McpOAuthCompleteResponse, Error>;
  readonly getSource: (
    namespace: string,
  ) => Effect.Effect<McpStoredSource | null, Error>;
  readonly updateSource: (
    namespace: string,
    input: McpUpdateSourceInput,
  ) => Effect.Effect<void, Error>;
}
