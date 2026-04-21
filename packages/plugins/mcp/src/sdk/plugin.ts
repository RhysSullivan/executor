import { Duration, Effect, Exit, Schema, Scope, ScopedCache } from "effect";

import {
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  ConnectionId,
  ConnectionRefreshError,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  SourceDetectionResult,
  TokenMaterial,
  definePlugin,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
  type PluginCtx,
  type StorageFailure,
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
import {
  McpToolBinding,
  McpJsonObject,
  type McpConnectionAuth,
  type McpStoredSourceData,
} from "./types";

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

/**
 * Executor scope id that owns a newly-added MCP source row. Must be one
 * of the executor's configured scopes. Admins adding a shared server at
 * org scope pin here; per-user stdio sources can pin at the inner
 * scope.
 */
type McpSourceScopeField = { readonly scope: string };

export interface McpRemoteSourceConfig extends McpSourceScopeField {
  readonly transport: "remote";
  readonly name: string;
  readonly endpoint: string;
  readonly remoteTransport?: "streamable-http" | "sse" | "auto";
  readonly queryParams?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly namespace?: string;
  readonly auth?: McpConnectionAuth;
}

export interface McpStdioSourceConfig extends McpSourceScopeField {
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
  /**
   * Executor scope id where the minted Connection will land. Defaults
   * to `ctx.scopes[0].id` (innermost) — for a per-user stack
   * `[user, org]` that pins the connection to the user scope so the
   * source's stored `connectionId` resolves per-user via shadowing.
   */
  readonly tokenScope?: string;
  /**
   * Pre-decided SDK connection id the exchange will mint. Stable per
   * source (typically `mcp-oauth2-${namespace}`) so multiple users
   * signing in against the same MCP source all write to the same id at
   * their own scope — `ctx.connections.accessToken(id)` then resolves
   * innermost-first.
   */
  readonly connectionId: string;
  /**
   * Source-level OAuth state captured by a previous user's flow. Pass
   * the values stored on the source's auth config to skip Dynamic
   * Client Registration — the new user's flow re-uses the same
   * client_id and discovery results.
   */
  readonly clientInformation?: Record<string, unknown> | null;
  readonly authorizationServerUrl?: string | null;
  readonly resourceMetadataUrl?: string | null;
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
  /** Id of the SDK Connection the exchange minted. The caller stores it
   *  on the source's `oauth2` auth field and resolves tokens via
   *  `ctx.connections`. */
  readonly connectionId: string;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
  /** DCR client + discovery URLs captured during the flow. The UI
   *  stores them on the source's auth config so subsequent users can
   *  skip DCR and re-discovery. */
  readonly clientInformation: Record<string, unknown> | null;
  readonly authorizationServerUrl: string | null;
  readonly resourceMetadataUrl: string | null;
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

interface OAuthProviderInputs {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Source-level state — same for every user. Surfaced to the MCP
   *  transport so internal DCR/discovery lookups find a populated
   *  provider, but never used to mint tokens: refresh is owned by the
   *  SDK via `ctx.connections.accessToken`. */
  readonly clientInformation?: OAuthClientInformationMixed | null;
  readonly authorizationServerUrl?: string | null;
  readonly resourceMetadataUrl?: string | null;
  readonly endpoint: string;
}

const makeOAuthProvider = (inputs: OAuthProviderInputs): OAuthClientProvider => {
  const currentTokens: OAuthTokens = {
    access_token: inputs.accessToken,
    token_type: inputs.tokenType,
  };
  let clientInformation: OAuthClientInformationMixed | undefined =
    inputs.clientInformation ?? undefined;
  let discoveryState: OAuthDiscoveryState | undefined =
    inputs.authorizationServerUrl || inputs.resourceMetadataUrl
      ? {
          authorizationServerUrl:
            inputs.authorizationServerUrl ?? new URL("/", inputs.endpoint).toString(),
          resourceMetadataUrl: inputs.resourceMetadataUrl ?? undefined,
        }
      : undefined;

  return {
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
    clientInformation: () => clientInformation,
    saveClientInformation: (ci) => {
      clientInformation = ci;
    },
    tokens: () => currentTokens,
    // No-op: token refresh is driven by the SDK through
    // `ctx.connections.accessToken`, and the access token resolved at
    // `resolveConnectorInput` time is the only one this provider ever
    // hands to the transport. A 401 from the server flips the
    // invokeMcpTool retry path, which invalidates the cached connection
    // and re-resolves — picking up a freshly refreshed token.
    saveTokens: () => undefined,
    redirectToAuthorization: async () => {
      throw new Error("MCP OAuth re-authorization required");
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => {
      throw new Error("No active PKCE verifier");
    },
    saveDiscoveryState: (s) => {
      discoveryState = s;
    },
    discoveryState: () => discoveryState,
  };
};

// ---------------------------------------------------------------------------
// Connection `provider_state` shape for mcp-oauth2.
//
// Carries everything the SDK hands to the refresh handler so it can
// re-hit the token endpoint without re-reading plugin storage. The DCR
// client info is NOT sensitive on its own — the MCP SDK's DCR flow uses
// `token_endpoint_auth_method: "none"` (PKCE), so there's no
// client_secret to protect. Having it here lets the refresh handler
// skip discovery entirely.
// ---------------------------------------------------------------------------

const MCP_OAUTH2_PROVIDER_KEY = "mcp:oauth2" as const;

const OAuth2ProviderState = Schema.Struct({
  endpoint: Schema.String,
  tokenType: Schema.String,
  // Nullable to accommodate early-onboarded sources where DCR client
  // registration was never persisted back onto the source. Refresh fails
  // fast on null and surfaces a "re-sign-in required" error, which the UI
  // turns into a Reconnect prompt.
  clientInformation: Schema.NullOr(McpJsonObject),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  authorizationServerMetadata: Schema.NullOr(McpJsonObject),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(McpJsonObject),
});
type OAuth2ProviderState = typeof OAuth2ProviderState.Type;

const encodeProviderState = Schema.encodeSync(OAuth2ProviderState);
const decodeProviderState = Schema.decodeUnknownSync(OAuth2ProviderState);

const toProviderStateRecord = (
  state: OAuth2ProviderState,
): Record<string, unknown> =>
  encodeProviderState(state) as unknown as Record<string, unknown>;

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
): Effect.Effect<ConnectorInput, McpConnectionError | StorageFailure> => {
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
      // `accessToken(id)` handles refresh internally — by the time we
      // hand the value to the MCP transport it's guaranteed fresh. The
      // connection row carries the DCR client + discovery metadata in
      // `providerState`, but we read it off the connection here only
      // for the `OAuthClientProvider` surface; the actual token
      // material is what matters at the wire.
      const accessToken = yield* ctx.connections
        .accessToken(auth.connectionId)
        .pipe(
          Effect.mapError((err) =>
            remoteConnectionError(
              `Failed to resolve OAuth connection "${auth.connectionId}": ${
                "message" in err
                  ? (err as { message: string }).message
                  : String(err)
              }`,
            ),
          ),
        );

      const connection = yield* ctx.connections.get(auth.connectionId);
      const providerState: OAuth2ProviderState | null =
        connection?.providerState
          ? yield* Effect.sync(() => {
              try {
                return decodeProviderState(connection.providerState);
              } catch {
                return null;
              }
            })
          : null;

      authProvider = makeOAuthProvider({
        accessToken,
        tokenType: providerState?.tokenType ?? "Bearer",
        clientInformation:
          (providerState?.clientInformation as OAuthClientInformationMixed | undefined) ??
          null,
        authorizationServerUrl: providerState?.authorizationServerUrl ?? null,
        resourceMetadataUrl: providerState?.resourceMetadataUrl ?? null,
        endpoint: sd.endpoint,
      });
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

const makeRuntime = (): Effect.Effect<McpRuntime, never> =>
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
    connectionId: auth.connectionId,
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

    const ensureRuntime = (): Effect.Effect<McpRuntime, never> =>
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
              Effect.withSpan("mcp.plugin.discover_tools"),
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
              Effect.withSpan("mcp.plugin.probe_oauth"),
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
          }).pipe(
            Effect.withSpan("mcp.plugin.probe_endpoint", {
              attributes: { "mcp.endpoint": endpoint },
            }),
          );

        const configFile = options?.configFile;

        const addSource = (config: McpSourceConfig) =>
          Effect.gen(function* () {
            const namespace = normalizeNamespace(config);
            const sd = toStoredSourceData(config);

            // Resolve auth (may fail if stdio gate is off)
            const ci = yield* resolveConnectorInput(sd, ctx, allowStdio).pipe(
              Effect.withSpan("mcp.plugin.resolve_connector", {
                attributes: {
                  "mcp.source.namespace": namespace,
                  "mcp.source.transport": sd.transport,
                },
              }),
            );

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
              Effect.withSpan("mcp.plugin.discover_tools", {
                attributes: { "mcp.source.namespace": namespace },
              }),
            );
            const manifest =
              discovery._tag === "Right"
                ? discovery.right
                : { server: undefined, tools: [] as const };

            const sourceName = manifest.server?.name ?? config.name ?? namespace;

            yield* ctx
              .transaction(
                Effect.gen(function* () {
                  // Remove stale rows at the target scope (plugin-owned).
                  // Pinning scope keeps a shadowed outer-scope row intact
                  // when a per-user addSource re-uses the same namespace.
                  yield* ctx.storage.removeBindingsByNamespace(
                    namespace,
                    config.scope,
                  );
                  yield* ctx.storage.removeSource(namespace, config.scope);

                  yield* ctx.storage.putSource({
                    namespace,
                    scope: config.scope,
                    name: sourceName,
                    config: sd,
                  });

                  yield* ctx.storage.putBindings(
                    namespace,
                    config.scope,
                    manifest.tools.map((e) => ({
                      toolId: `${namespace}.${e.toolId}`,
                      binding: toBinding(e),
                    })),
                  );

                  yield* ctx.core.sources.register({
                    id: namespace,
                    scope: config.scope,
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
              )
              .pipe(
                Effect.withSpan("mcp.plugin.persist_source", {
                  attributes: {
                    "mcp.source.namespace": namespace,
                    "mcp.source.tool_count": manifest.tools.length,
                  },
                }),
              );

            if (configFile) {
              yield* configFile
                .upsertSource(toMcpConfigEntry(namespace, sourceName, config))
                .pipe(Effect.withSpan("mcp.plugin.config_file.upsert"));
            }

            if (discovery._tag === "Left") {
              return yield* Effect.fail(discovery.left);
            }
            return { toolCount: manifest.tools.length, namespace };
          }).pipe(
            Effect.withSpan("mcp.plugin.add_source", {
              attributes: {
                "mcp.source.transport": config.transport,
                "mcp.source.name": config.name,
              },
            }),
          );

        const removeSource = (namespace: string, scope: string) =>
          Effect.gen(function* () {
            yield* ctx
              .transaction(
                Effect.gen(function* () {
                  yield* ctx.storage.removeBindingsByNamespace(namespace, scope);
                  yield* ctx.storage.removeSource(namespace, scope);
                  yield* ctx.core.sources.unregister(namespace);
                }),
              )
              .pipe(Effect.withSpan("mcp.plugin.persist_remove"));
            if (configFile) {
              yield* configFile
                .removeSource(namespace)
                .pipe(Effect.withSpan("mcp.plugin.config_file.remove"));
            }
          }).pipe(
            Effect.withSpan("mcp.plugin.remove_source", {
              attributes: { "mcp.source.namespace": namespace },
            }),
          );

        const refreshSource = (namespace: string, scope: string) =>
          Effect.gen(function* () {
            const sd = yield* ctx.storage.getSourceConfig(namespace, scope).pipe(
              Effect.withSpan("mcp.plugin.load_source_config", {
                attributes: { "mcp.source.namespace": namespace },
              }),
            );
            if (!sd) {
              return yield* Effect.fail(
                remoteConnectionError(
                  `No stored config for MCP source "${namespace}"`,
                ),
              );
            }

            const ci = yield* resolveConnectorInput(sd, ctx, allowStdio).pipe(
              Effect.withSpan("mcp.plugin.resolve_connector", {
                attributes: {
                  "mcp.source.namespace": namespace,
                  "mcp.source.transport": sd.transport,
                },
              }),
            );
            const manifest = yield* discoverTools(createMcpConnector(ci)).pipe(
              Effect.mapError((err) =>
                mcpDiscoveryError(`MCP refresh failed: ${err.message}`),
              ),
              Effect.withSpan("mcp.plugin.discover_tools", {
                attributes: { "mcp.source.namespace": namespace },
              }),
            );

            const existing = yield* ctx.storage.getSource(namespace, scope);
            const sourceName =
              manifest.server?.name ?? existing?.name ?? namespace;

            yield* ctx
              .transaction(
                Effect.gen(function* () {
                  yield* ctx.storage.removeBindingsByNamespace(namespace, scope);
                  yield* ctx.core.sources.unregister(namespace);

                  yield* ctx.storage.putBindings(
                    namespace,
                    scope,
                    manifest.tools.map((e) => ({
                      toolId: `${namespace}.${e.toolId}`,
                      binding: toBinding(e),
                    })),
                  );
                  yield* ctx.core.sources.register({
                    id: namespace,
                    scope,
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
              )
              .pipe(
                Effect.withSpan("mcp.plugin.persist_source", {
                  attributes: {
                    "mcp.source.namespace": namespace,
                    "mcp.source.tool_count": manifest.tools.length,
                  },
                }),
              );

            return { toolCount: manifest.tools.length };
          }).pipe(
            Effect.withSpan("mcp.plugin.refresh_source", {
              attributes: { "mcp.source.namespace": namespace },
            }),
          );

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
            const tokenScope = input.tokenScope ?? (ctx.scopes[0]!.id as string);
            const started = yield* startMcpOAuthAuthorization({
              endpoint: fullEndpoint,
              redirectUrl: input.redirectUrl,
              state: sessionId,
              clientInformation: input.clientInformation as
                | OAuthClientInformationMixed
                | null
                | undefined,
              authorizationServerUrl: input.authorizationServerUrl,
              resourceMetadataUrl: input.resourceMetadataUrl,
            }).pipe(
              Effect.mapError((e) =>
                mcpOAuthError(`OAuth start failed: ${e.message}`),
              ),
              Effect.withSpan("mcp.plugin.oauth.start_authorization"),
            );

            yield* ctx.storage
              .putOAuthSession(sessionId, tokenScope, {
                endpoint: fullEndpoint,
                redirectUrl: input.redirectUrl,
                codeVerifier: started.codeVerifier,
                resourceMetadataUrl: started.resourceMetadataUrl,
                authorizationServerUrl: started.authorizationServerUrl,
                resourceMetadata: started.resourceMetadata,
                authorizationServerMetadata: started.authorizationServerMetadata,
                clientInformation: started.clientInformation,
                tokenScope,
                connectionId: input.connectionId,
              })
              .pipe(Effect.withSpan("mcp.plugin.oauth.persist_session"));

            return {
              sessionId,
              authorizationUrl: started.authorizationUrl,
            };
          }).pipe(Effect.withSpan("mcp.plugin.start_oauth"));

        const completeOAuth = (input: McpOAuthCompleteInput) =>
          ctx
            .transaction(
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
                  Effect.withSpan("mcp.plugin.oauth.exchange_code"),
                );

                yield* ctx.storage.deleteOAuthSession(input.state);

                const tokenType = exchanged.tokens.token_type ?? "Bearer";
                const expiresAt =
                  typeof exchanged.tokens.expires_in === "number"
                    ? Date.now() + exchanged.tokens.expires_in * 1000
                    : null;

                // Derive a friendly label for the Connections page. MCP
                // OAuth tokens don't include identity claims, so fall back
                // to the endpoint host (e.g., "mcp.axiom.co"), which is
                // what the user recognises from the source they added.
                let derivedLabel: string | null = null;
                try {
                  derivedLabel = new URL(session.endpoint).host;
                } catch {
                  derivedLabel = null;
                }

                const providerState: OAuth2ProviderState = {
                  endpoint: session.endpoint,
                  tokenType,
                  clientInformation:
                    (exchanged.clientInformation as Record<string, unknown> | null) ??
                    (session.clientInformation ?? {}),
                  authorizationServerUrl:
                    exchanged.authorizationServerUrl ??
                    session.authorizationServerUrl,
                  authorizationServerMetadata:
                    exchanged.authorizationServerMetadata ??
                    session.authorizationServerMetadata,
                  resourceMetadataUrl:
                    exchanged.resourceMetadataUrl ?? session.resourceMetadataUrl,
                  resourceMetadata:
                    exchanged.resourceMetadata ?? session.resourceMetadata,
                };

                // Mint the connection + its owned access/refresh secret
                // rows in one transactional write. The session-pinned
                // `connectionId` stays stable across re-auths by the same
                // source, which means the UI's stored `{kind: "oauth2",
                // connectionId}` on the source auth config resolves
                // per-user via scope shadowing once each user completes
                // their own OAuth.
                yield* ctx.connections
                  .create(
                    new CreateConnectionInput({
                      id: ConnectionId.make(session.connectionId),
                      scope: ScopeId.make(session.tokenScope),
                      provider: MCP_OAUTH2_PROVIDER_KEY,
                      kind: "user",
                      identityLabel: derivedLabel,
                      accessToken: new TokenMaterial({
                        secretId: SecretId.make(
                          `${session.connectionId}.access_token`,
                        ),
                        name: "MCP OAuth Access Token",
                        value: exchanged.tokens.access_token,
                      }),
                      refreshToken: exchanged.tokens.refresh_token
                        ? new TokenMaterial({
                            secretId: SecretId.make(
                              `${session.connectionId}.refresh_token`,
                            ),
                            name: "MCP OAuth Refresh Token",
                            value: exchanged.tokens.refresh_token,
                          })
                        : null,
                      expiresAt,
                      oauthScope: exchanged.tokens.scope ?? null,
                      providerState: toProviderStateRecord(providerState),
                    }),
                  )
                  .pipe(
                    Effect.mapError((err) =>
                      mcpOAuthError(
                        `Failed to create OAuth connection: ${
                          "message" in err
                            ? (err as { message: string }).message
                            : String(err)
                        }`,
                      ),
                    ),
                  );

                return {
                  connectionId: session.connectionId,
                  tokenType,
                  expiresAt,
                  scope: exchanged.tokens.scope ?? null,
                  // Echo the source-level OAuth state captured during this
                  // flow. The UI persists it on the source's auth config
                  // so subsequent users can skip DCR + re-discovery.
                  clientInformation: exchanged.clientInformation as
                    | Record<string, unknown>
                    | null,
                  authorizationServerUrl: exchanged.authorizationServerUrl,
                  resourceMetadataUrl: exchanged.resourceMetadataUrl,
                };
              }),
            )
            .pipe(Effect.withSpan("mcp.plugin.complete_oauth"));

        const updateSource = (
          namespace: string,
          scope: string,
          input: McpUpdateSourceInput,
        ) =>
          Effect.gen(function* () {
            const existing = yield* ctx.storage.getSource(namespace, scope);
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
              scope,
              name: input.name?.trim() || existing.name,
              config: updatedConfig,
            });
          }).pipe(
            Effect.withSpan("mcp.plugin.update_source", {
              attributes: { "mcp.source.namespace": namespace },
            }),
          );

        const getSource = (namespace: string, scope: string) =>
          ctx.storage.getSource(namespace, scope).pipe(
            Effect.withSpan("mcp.plugin.get_source", {
              attributes: { "mcp.source.namespace": namespace },
            }),
          );

        return {
          probeEndpoint,
          addSource,
          removeSource,
          refreshSource,
          startOAuth,
          completeOAuth,
          getSource,
          updateSource,
        } satisfies McpPluginExtension;
      },

      invokeTool: ({ ctx, toolRow, args, elicit }) =>
        Effect.gen(function* () {
          const runtime = yield* ensureRuntime();

          // toolRow.scope_id is the resolved owning scope of the tool
          // (innermost-wins from the executor's stack). The matching
          // mcp_binding + mcp_source rows live at the same scope, so
          // pin every store lookup to it instead of relying on the
          // scoped adapter's stack-wide fall-through.
          const toolScope = toolRow.scope_id as string;
          const entry = yield* ctx.storage.getBinding(toolRow.id, toolScope).pipe(
            Effect.withSpan("mcp.plugin.load_binding", {
              attributes: { "mcp.tool.name": toolRow.id },
            }),
          );
          if (!entry) {
            return yield* Effect.fail(
              new Error(`No MCP binding found for tool "${toolRow.id}"`),
            );
          }

          const sd = yield* ctx.storage.getSourceConfig(entry.namespace, toolScope).pipe(
            Effect.withSpan("mcp.plugin.load_source_config", {
              attributes: { "mcp.source.namespace": entry.namespace },
            }),
          );
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
            invokerScope: ctx.scopes[0]!.id as string,
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
                Effect.withSpan("mcp.plugin.resolve_connector", {
                  attributes: {
                    "mcp.source.namespace": entry.namespace,
                    "mcp.source.transport": sd.transport,
                  },
                }),
              ),
            connectionCache: runtime.connectionCache,
            pendingConnectors: runtime.pendingConnectors,
            elicit,
          });
        }).pipe(
          Effect.withSpan("mcp.plugin.invoke_tool", {
            attributes: {
              "mcp.tool.name": toolRow.id,
              "mcp.tool.source_id": toolRow.source_id,
            },
          }),
        ),

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
            Effect.withSpan("mcp.plugin.discover_tools"),
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
            Effect.withSpan("mcp.plugin.probe_oauth"),
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
        }).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
          Effect.withSpan("mcp.plugin.detect", {
            attributes: { "mcp.endpoint": url },
          }),
        ),

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

      removeSource: ({ ctx, sourceId, scope }) =>
        Effect.gen(function* () {
          yield* ctx.storage.removeBindingsByNamespace(sourceId, scope);
          yield* ctx.storage.removeSource(sourceId, scope);
        }),

      refreshSource: () => Effect.void,

      // The SDK's `ctx.connections.accessToken(id)` dispatches here when
      // a connection with `provider: "mcp:oauth2"` is near expiry. The
      // providerState blob — captured in completeOAuth — carries
      // everything the MCP SDK needs to skip discovery + DCR and go
      // straight to the refresh token endpoint.
      connectionProviders: (_ctx): readonly ConnectionProvider[] => [
        {
          key: MCP_OAUTH2_PROVIDER_KEY,
          refresh: (input: ConnectionRefreshInput) =>
            Effect.gen(function* () {
              if (!input.providerState) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: "mcp:oauth2 connection is missing providerState",
                });
              }
              const refreshToken = input.refreshToken;
              if (!refreshToken) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: "mcp:oauth2 connection has no refresh token",
                });
              }
              const state = yield* Effect.try({
                try: () => decodeProviderState(input.providerState),
                catch: (cause) =>
                  new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `mcp:oauth2 providerState is malformed: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                    cause,
                  }),
              });

              if (state.clientInformation === null) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message:
                    "mcp:oauth2 connection has no clientInformation — re-sign-in required (legacy row; DCR was never persisted)",
                });
              }

              const authServerUrl =
                state.authorizationServerUrl ??
                new URL("/", state.endpoint).toString();

              const tokens = yield* Effect.tryPromise({
                try: () =>
                  refreshAuthorization(authServerUrl, {
                    metadata:
                      (state.authorizationServerMetadata as
                        | OAuthMetadata
                        | null) ?? undefined,
                    clientInformation:
                      state.clientInformation as OAuthClientInformationMixed,
                    refreshToken,
                  }),
                catch: (cause) =>
                  new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `MCP OAuth refresh failed: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                    cause,
                  }),
              });

              const expiresAt =
                typeof tokens.expires_in === "number"
                  ? Date.now() + tokens.expires_in * 1000
                  : null;

              // The MCP SDK preserves the original refresh_token if the
              // AS doesn't rotate (see refreshAuthorization doc-comment),
              // so we forward whatever it returned. Undefined here would
              // mean "keep the stored one", but we always pass the
              // current value through for consistency.
              const result: ConnectionRefreshResult = {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token ?? undefined,
                expiresAt,
                oauthScope: tokens.scope ?? input.oauthScope,
              };
              return result;
            }),
        },
      ],

      close: () =>
        Effect.gen(function* () {
          const runtime = runtimeRef.current;
          if (runtime) {
            runtime.pendingConnectors.clear();
            yield* runtime.connectionCache.invalidateAll;
            yield* Scope.close(runtime.cacheScope, Exit.void);
            runtimeRef.current = null;
          }
        }).pipe(Effect.withSpan("mcp.plugin.close")),
    };
  },
);

// ---------------------------------------------------------------------------
// McpPluginExtension — shape of `executor.mcp` for consumers that want
// to type against it directly (api/, react/). Mirrors what `extension`
// returns above.
// ---------------------------------------------------------------------------

/**
 * Errors any MCP extension method may surface. The first four are
 * plugin-domain tagged errors that flow directly to clients (4xx, each
 * carrying its own `HttpApiSchema` status). `StorageFailure` covers
 * raw backend failures (`StorageError`) plus `UniqueViolationError`;
 * the HTTP edge (`@executor/api`'s `withCapture`) translates
 * `StorageError` to the opaque `InternalError({ traceId })` at Layer
 * composition. `UniqueViolationError` passes through — plugins can
 * `Effect.catchTag` it if they want a friendlier user-facing error.
 */
export type McpExtensionFailure =
  | McpOAuthError
  | McpConnectionError
  | McpToolDiscoveryError
  | StorageFailure;

export interface McpPluginExtension {
  readonly probeEndpoint: (
    endpoint: string,
  ) => Effect.Effect<McpProbeResult, McpExtensionFailure>;
  readonly addSource: (
    config: McpSourceConfig,
  ) => Effect.Effect<
    { readonly toolCount: number; readonly namespace: string },
    McpExtensionFailure
  >;
  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, McpExtensionFailure>;
  readonly refreshSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<{ readonly toolCount: number }, McpExtensionFailure>;
  readonly startOAuth: (
    input: McpOAuthStartInput,
  ) => Effect.Effect<McpOAuthStartResponse, McpExtensionFailure>;
  readonly completeOAuth: (
    input: McpOAuthCompleteInput,
  ) => Effect.Effect<McpOAuthCompleteResponse, McpExtensionFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<McpStoredSource | null, McpExtensionFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: McpUpdateSourceInput,
  ) => Effect.Effect<void, McpExtensionFailure>;
}
