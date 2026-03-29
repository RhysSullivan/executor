import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  ToolExecutionContext,
  ToolInput,
  ToolPath,
} from "@executor/codemode-core";
import {
  exchangeMcpOAuthAuthorizationCode,
  startMcpOAuthAuthorization,
} from "./oauth";
import {
  contentHash,
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
  normalizeSourceDiscoveryUrl,
  probeHeadersFromAuth,
  SourceTransportSchema,
  StringArraySchema,
  StringMapSchema,
  type SourceDiscoveryResult,
} from "@executor/source-core";
import {
  type Source,
  SourceSchema,
} from "@executor/platform-sdk/schema";
import {
  defineExecutorSourcePlugin,
} from "@executor/platform-sdk/plugins";
import {
  createPluginLocalConfigEntrySchema,
  pluginLocalConfigSourceFromConfig,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  provideExecutorRuntime,
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";
import {
  McpConnectInputSchema,
  McpConnectionAuthSchema,
  McpDiscoverInputSchema,
  McpDiscoverResultSchema,
  McpOAuthPopupResultSchema,
  McpOAuthSessionSchema,
  McpSourceConfigPayloadSchema,
  McpStartOAuthInputSchema,
  McpStartOAuthResultSchema,
  McpStoredSourceDataSchema,
  McpUpdateSourceInputSchema,
  deriveMcpNamespace,
  resolveMcpEndpoint,
  type McpConnectInput,
  type McpDiscoverInput,
  type McpDiscoverResult,
  type McpConnectionAuth,
  type McpOAuthPopupResult,
  type McpOAuthSession,
  type McpSourceConfigPayload,
  type McpStartOAuthInput,
  type McpStartOAuthResult,
  type McpStoredSourceData,
  type McpUpdateSourceInput,
} from "@executor/plugin-mcp-shared";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createMcpCatalogFragment,
  type McpCatalogOperationInput,
} from "./catalog";
import {
  detectMcpSource,
} from "./discovery";
import {
  createPooledMcpConnector,
} from "./connection-pool";
import {
  createSdkMcpConnector,
  isMcpStdioTransport,
} from "./connection";
import {
  joinToolPath,
  type McpServerMetadata,
  type McpToolManifestEntry,
} from "./manifest";
import {
  createMcpToolsFromManifest,
  discoverMcpToolsFromConnector,
} from "./tools";

const decodeStoredSourceData = Schema.decodeUnknownSync(McpStoredSourceDataSchema);
const decodeSession = Schema.decodeUnknownSync(McpOAuthSessionSchema);

const McpSourceIdInputSchema = Schema.Struct({
  sourceId: Schema.String,
});
const McpCompleteOAuthInputSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errorDescription: Schema.optional(Schema.String),
});

const McpExecutableBindingSchema = Schema.Struct({
  toolId: Schema.String,
  toolName: Schema.String,
  displayTitle: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  annotations: Schema.NullOr(Schema.Unknown),
  execution: Schema.NullOr(Schema.Unknown),
  icons: Schema.NullOr(Schema.Unknown),
  meta: Schema.NullOr(Schema.Unknown),
  rawTool: Schema.NullOr(Schema.Unknown),
  server: Schema.NullOr(Schema.Unknown),
});

type McpExecutableBinding = typeof McpExecutableBindingSchema.Type;

const decodeProviderData = Schema.decodeUnknownSync(McpExecutableBindingSchema);

export type McpSourceStorage = {
  get: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<McpStoredSourceData | null, Error, never>;
  put: (input: {
    scopeId: string;
    sourceId: string;
    value: McpStoredSourceData;
  }) => Effect.Effect<void, Error, never>;
  remove?: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<void, Error, never>;
};

export type McpOAuthSessionStorage = {
  get: (sessionId: string) => Effect.Effect<McpOAuthSession | null, Error, never>;
  put: (input: {
    sessionId: string;
    value: McpOAuthSession;
  }) => Effect.Effect<void, Error, never>;
  remove?: (sessionId: string) => Effect.Effect<void, Error, never>;
};

export type McpSdk = {
  getSourceConfig: (
    sourceId: Source["id"],
  ) => Effect.Effect<McpSourceConfigPayload, Error>;
  discoverSource: (
    input: McpDiscoverInput,
  ) => Effect.Effect<McpDiscoverResult, Error>;
  createSource: (
    input: McpConnectInput,
  ) => Effect.Effect<Source, Error>;
  updateSource: (
    input: McpUpdateSourceInput,
  ) => Effect.Effect<Source, Error>;
  removeSource: (
    sourceId: Source["id"],
  ) => Effect.Effect<boolean, Error>;
  startOAuth: (
    input: McpStartOAuthInput,
  ) => Effect.Effect<McpStartOAuthResult, Error>;
  completeOAuth: (input: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }) => Effect.Effect<Extract<McpOAuthPopupResult, { ok: true }>, Error>;
};

const McpExecutorAddInputSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literal("mcp")),
  name: Schema.String,
  endpoint: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(Schema.Literal("streamable-http", "sse", "stdio", "auto")),
  queryParams: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
  headers: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
  command: Schema.NullOr(Schema.String),
  args: Schema.NullOr(Schema.Array(Schema.String)),
  env: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
  cwd: Schema.NullOr(Schema.String),
  auth: McpConnectionAuthSchema,
});

type McpExecutorAddInput = typeof McpExecutorAddInputSchema.Type;

export type McpSdkPluginOptions = {
  storage: McpSourceStorage;
  oauthSessions: McpOAuthSessionStorage;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const trimOrNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeStringRecord = (
  value: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> | null => {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const trimmedKey = key.trim();
      const trimmedValue = entry.trim();
      return trimmedKey.length > 0 && trimmedValue.length > 0
        ? [[trimmedKey, trimmedValue]]
        : [];
    }),
  );

  return Object.keys(normalized).length > 0 ? normalized : null;
};

const normalizeStringArray = (
  value: ReadonlyArray<string> | null | undefined,
): Array<string> | null => {
  if (!value || value.length === 0) {
    return null;
  }

  const normalized = value
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : null;
};

const decodeMcpAuthOption = Schema.decodeUnknownOption(McpConnectionAuthSchema);
const decodeMcpCurrentLocalConfigOption = Schema.decodeUnknownOption(
  createPluginLocalConfigEntrySchema({
    kind: "mcp",
    config: McpStoredSourceDataSchema,
  }),
);
const decodeMcpLegacyLocalConfigOption = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    connection: Schema.optional(
      Schema.Struct({
        endpoint: Schema.optional(Schema.NullOr(Schema.String)),
        auth: Schema.optional(Schema.Unknown),
      }),
    ),
    binding: Schema.Struct({
      transport: Schema.optional(Schema.NullOr(SourceTransportSchema)),
      queryParams: Schema.optional(Schema.NullOr(StringMapSchema)),
      headers: Schema.optional(Schema.NullOr(StringMapSchema)),
      command: Schema.optional(Schema.NullOr(Schema.String)),
      args: Schema.optional(Schema.NullOr(StringArraySchema)),
      env: Schema.optional(Schema.NullOr(StringMapSchema)),
      cwd: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    config: Schema.optional(Schema.Unknown),
  }),
);

const normalizeStoredSourceData = (
  input: McpConnectInput | McpSourceConfigPayload,
): Effect.Effect<McpStoredSourceData, Error, never> =>
  Effect.gen(function* () {
    const endpoint = trimOrNull(input.endpoint);
    const command = trimOrNull(input.command);
    const transport = input.transport ?? null;
    const queryParams = normalizeStringRecord(input.queryParams);
    const headers = normalizeStringRecord(input.headers);
    const args = normalizeStringArray(input.args);
    const env = normalizeStringRecord(input.env);
    const cwd = trimOrNull(input.cwd);
    const stdio = isMcpStdioTransport({
      transport: transport ?? undefined,
      command: command ?? undefined,
    });

    if (stdio) {
      if (command === null) {
        return yield* runtimeEffectError(
          "plugins/mcp/sdk",
          "MCP stdio transport requires a command.",
        );
      }

      if (queryParams !== null) {
        return yield* runtimeEffectError(
          "plugins/mcp/sdk",
          "MCP stdio transport does not support query params.",
        );
      }

      if (headers !== null) {
        return yield* runtimeEffectError(
          "plugins/mcp/sdk",
          "MCP stdio transport does not support request headers.",
        );
      }

      return decodeStoredSourceData({
        endpoint: null,
        transport: "stdio",
        queryParams: null,
        headers: null,
        command,
        args,
        env,
        cwd,
        auth: input.auth,
      });
    }

    if (endpoint === null) {
      return yield* runtimeEffectError(
        "plugins/mcp/sdk",
        "MCP remote transports require an endpoint.",
      );
    }

    if (command !== null || args !== null || env !== null || cwd !== null) {
      return yield* runtimeEffectError(
        "plugins/mcp/sdk",
        'MCP process settings require transport "stdio".',
      );
    }

    return decodeStoredSourceData({
      endpoint,
      transport,
      queryParams,
      headers,
      command: null,
      args: null,
      env: null,
      cwd: null,
      auth: input.auth,
    });
  });

const sourceConfigFromStored = (
  source: Source,
  stored: McpStoredSourceData,
): McpSourceConfigPayload => ({
  name: source.name,
  endpoint: stored.endpoint,
  transport: stored.transport,
  queryParams: stored.queryParams,
  headers: stored.headers,
  command: stored.command,
  args: stored.args,
  env: stored.env,
  cwd: stored.cwd,
  auth: stored.auth,
});

const mcpConnectInputFromAddInput = (
  input: McpExecutorAddInput,
): McpConnectInput => ({
  name: input.name,
  endpoint: input.endpoint,
  transport: input.transport,
  queryParams: input.queryParams,
  headers: input.headers,
  command: input.command,
  args: input.args,
  env: input.env,
  cwd: input.cwd,
  auth: input.auth,
});

const mcpStoredSourceDataFromLocalConfig = (
  config: unknown,
): Effect.Effect<McpStoredSourceData, Error, never> => {
  const current = decodeMcpCurrentLocalConfigOption(config);
  if (Option.isSome(current)) {
    return Effect.succeed(current.value.config);
  }

  const legacy = decodeMcpLegacyLocalConfigOption(config);
  if (Option.isSome(legacy)) {
    const auth = decodeMcpAuthOption(legacy.value.connection?.auth);
    if (
      legacy.value.connection?.auth !== undefined &&
      Option.isNone(auth)
    ) {
      return runtimeEffectError(
        "plugins/mcp/sdk",
        "Unsupported MCP auth configuration in local source config.",
      );
    }

    return normalizeStoredSourceData({
      name: legacy.value.name ?? "MCP",
      endpoint: legacy.value.connection?.endpoint ?? null,
      transport: legacy.value.binding.transport ?? null,
      queryParams: legacy.value.binding.queryParams ?? null,
      headers: legacy.value.binding.headers ?? null,
      command: legacy.value.binding.command ?? null,
      args: legacy.value.binding.args ?? null,
      env: legacy.value.binding.env ?? null,
      cwd: legacy.value.binding.cwd ?? null,
      auth: Option.isSome(auth)
        ? auth.value
        : {
            kind: "none",
          },
    });
  }

  return runtimeEffectError(
    "plugins/mcp/sdk",
    "Unsupported MCP local source config.",
  );
};

const mcpCatalogOperationFromManifestEntry = (input: {
  entry: McpToolManifestEntry;
  server: McpServerMetadata | null | undefined;
}): McpCatalogOperationInput => ({
  toolId: input.entry.toolId,
  title:
    input.entry.displayTitle
    ?? input.entry.title
    ?? input.entry.toolName,
  description: input.entry.description ?? null,
  effect: input.entry.annotations?.readOnlyHint === true ? "read" : "write",
  inputSchema: input.entry.inputSchema,
  outputSchema: input.entry.outputSchema,
  providerData: {
    toolId: input.entry.toolId,
    toolName: input.entry.toolName,
    displayTitle:
      input.entry.displayTitle
      ?? input.entry.title
      ?? input.entry.toolName,
    title: input.entry.title ?? null,
    description: input.entry.description ?? null,
    annotations: input.entry.annotations ?? null,
    execution: input.entry.execution ?? null,
    icons: input.entry.icons ?? null,
    meta: input.entry.meta ?? null,
    rawTool: input.entry.rawTool ?? null,
    server: input.server ?? null,
  },
});

const expiresAtFromTokens = (tokens: OAuthTokens): number | null =>
  typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
    ? Date.now() + Math.max(0, tokens.expires_in) * 1000
    : null;

const expiresInFromAuth = (
  auth: Extract<McpConnectionAuth, { kind: "oauth2" }>,
): number | undefined => {
  if (auth.expiresAt === null) {
    return undefined;
  }

  return Math.max(0, Math.ceil((auth.expiresAt - Date.now()) / 1000));
};

const createPersistedMcpAuthProvider = (input: {
  scopeId: string;
  sourceId: string;
  stored: McpStoredSourceData;
  storage: McpSourceStorage;
}): Effect.Effect<OAuthClientProvider, Error, any> =>
  Effect.gen(function* () {
    if (input.stored.auth.kind !== "oauth2") {
      return yield* runtimeEffectError(
        "plugins/mcp/sdk",
        `Source ${input.sourceId} is not configured for MCP OAuth.`,
      );
    }

    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const updateSecretMaterial = yield* SecretMaterialUpdaterService;
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;

    let currentStored = input.stored;
    let currentAuth = input.stored.auth;

    const persistAuth = (
      nextAuth: Extract<McpConnectionAuth, { kind: "oauth2" }>,
    ) =>
      input.storage.put({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        value: {
          ...currentStored,
          auth: nextAuth,
        },
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            currentAuth = nextAuth;
            currentStored = {
              ...currentStored,
              auth: nextAuth,
            };
          })
        ),
      );

    return {
      get redirectUrl() {
        return currentAuth.redirectUri;
      },

      get clientMetadata() {
        return {
          redirect_uris: [currentAuth.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          client_name: "Executor Local",
        };
      },

      clientInformation: () =>
        currentAuth.clientInformation as OAuthClientInformationMixed | undefined,

      saveClientInformation: (clientInformation) =>
        Effect.runPromise(
          persistAuth({
            ...currentAuth,
            clientInformation:
              (clientInformation as Extract<McpConnectionAuth, { kind: "oauth2" }>["clientInformation"])
              ?? null,
          }),
        ).then(() => undefined),

      tokens: async () => {
        const accessToken = await Effect.runPromise(
          resolveSecretMaterial({
            ref: currentAuth.accessTokenRef,
          }),
        );
        const refreshToken = currentAuth.refreshTokenRef
          ? await Effect.runPromise(
              resolveSecretMaterial({
                ref: currentAuth.refreshTokenRef,
              }),
            )
          : undefined;

        return {
          access_token: accessToken,
          token_type: currentAuth.tokenType,
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
          ...(currentAuth.scope ? { scope: currentAuth.scope } : {}),
          ...(expiresInFromAuth(currentAuth) !== undefined
            ? { expires_in: expiresInFromAuth(currentAuth) }
            : {}),
        } satisfies OAuthTokens;
      },

      saveTokens: (tokens) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* updateSecretMaterial({
              ref: currentAuth.accessTokenRef,
              value: tokens.access_token,
            });

            let refreshTokenRef = currentAuth.refreshTokenRef;
            if (tokens.refresh_token) {
              if (refreshTokenRef) {
                yield* updateSecretMaterial({
                  ref: refreshTokenRef,
                  value: tokens.refresh_token,
                });
              } else {
                refreshTokenRef = yield* storeSecretMaterial({
                  purpose: "oauth_refresh_token",
                  value: tokens.refresh_token,
                  name: `${input.sourceId} MCP Refresh Token`,
                });
              }
            }

            yield* persistAuth({
              ...currentAuth,
              refreshTokenRef,
              tokenType: tokens.token_type ?? currentAuth.tokenType,
              expiresAt: expiresAtFromTokens(tokens) ?? currentAuth.expiresAt,
              scope: tokens.scope ?? currentAuth.scope,
            });
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                if (currentAuth.refreshTokenRef && tokens.refresh_token === undefined) {
                  yield* Effect.either(deleteSecretMaterial(currentAuth.refreshTokenRef));
                }
                return yield* Effect.fail(error);
              })
            ),
          ),
        ).then(() => undefined),

      redirectToAuthorization: async (authorizationUrl) => {
        throw new Error(
          `MCP OAuth re-authorization is required for ${input.sourceId}: ${authorizationUrl.toString()}`,
        );
      },

      saveCodeVerifier: () => undefined,

      codeVerifier: () => {
        throw new Error("Persisted MCP OAuth sessions do not retain an active PKCE verifier.");
      },

      saveDiscoveryState: (state) =>
        Effect.runPromise(
          persistAuth({
            ...currentAuth,
            resourceMetadataUrl: state.resourceMetadataUrl ?? null,
            authorizationServerUrl: state.authorizationServerUrl ?? null,
            resourceMetadata:
              (state.resourceMetadata as Extract<McpConnectionAuth, { kind: "oauth2" }>["resourceMetadata"])
              ?? null,
            authorizationServerMetadata:
              (state.authorizationServerMetadata as Extract<McpConnectionAuth, { kind: "oauth2" }>["authorizationServerMetadata"])
              ?? null,
          }),
        ).then(() => undefined),

      discoveryState: () =>
        currentAuth.authorizationServerUrl === null
          ? undefined
          : {
              resourceMetadataUrl: currentAuth.resourceMetadataUrl ?? undefined,
              authorizationServerUrl: currentAuth.authorizationServerUrl,
              resourceMetadata:
                currentAuth.resourceMetadata as OAuthDiscoveryState["resourceMetadata"],
              authorizationServerMetadata:
                currentAuth.authorizationServerMetadata as OAuthDiscoveryState["authorizationServerMetadata"],
            },
    } satisfies OAuthClientProvider;
  });

const createStoredMcpConnector = (input: {
  scopeId: string;
  sourceId: string;
  stored: McpStoredSourceData;
  storage: McpSourceStorage;
}): Effect.Effect<ReturnType<typeof createSdkMcpConnector>, Error, any> =>
  Effect.gen(function* () {
    const authProvider =
      input.stored.auth.kind === "oauth2"
        ? yield* createPersistedMcpAuthProvider(input)
        : undefined;

    return createSdkMcpConnector({
      endpoint: input.stored.endpoint ?? undefined,
      transport: input.stored.transport ?? undefined,
      queryParams: input.stored.queryParams ?? undefined,
      headers: input.stored.headers ?? undefined,
      authProvider,
      command: input.stored.command ?? undefined,
      args: input.stored.args ?? undefined,
      env: input.stored.env ?? undefined,
      cwd: input.stored.cwd ?? undefined,
    });
  });

const mcpDocumentKey = (stored: McpStoredSourceData): string =>
  stored.endpoint
  ?? (stored.command
    ? `stdio://${stored.command}`
    : "mcp");

export const mcpSdkPlugin = (
  options: McpSdkPluginOptions,
) => defineExecutorSourcePlugin<
  "mcp",
  McpExecutorAddInput,
  McpConnectInput,
  McpSourceConfigPayload,
  McpStoredSourceData,
  McpUpdateSourceInput,
  McpSdk
>({
  key: "mcp",
  source: {
    kind: "mcp",
    displayName: "MCP",
    add: {
      inputSchema: McpExecutorAddInputSchema,
      inputSignatureWidth: 320,
      helpText: [
        "Remote MCP sources use `endpoint`; local stdio sources use `command` plus `transport: \"stdio\"`.",
        "OAuth browser setup stays on the plugin-owned HTTP/UI surfaces.",
      ],
      toConnectInput: mcpConnectInputFromAddInput,
    },
    storage: options.storage,
    source: {
      create: (input) => ({
        source: {
          name: input.name.trim(),
          kind: "mcp",
          status: "connected",
          enabled: true,
          namespace: deriveMcpNamespace({
            name: input.name,
            endpoint: input.endpoint,
            command: input.command,
          }),
        },
        stored: Effect.runSync(normalizeStoredSourceData(input)),
      }),
      update: ({ source, config }) => {
        const stored = Effect.runSync(normalizeStoredSourceData(config));

        return {
          source: {
            ...source,
            name: config.name.trim(),
            namespace: deriveMcpNamespace({
              name: config.name,
              endpoint: stored.endpoint,
              command: stored.command,
            }),
          },
          stored,
        };
      },
      toConfig: ({ source, stored }) => sourceConfigFromStored(source, stored),
      remove: ({ stored }) =>
        Effect.gen(function* () {
          if (stored?.auth.kind === "oauth2") {
            const deleteSecretMaterial = yield* SecretMaterialDeleterService;
            yield* Effect.either(deleteSecretMaterial(stored.auth.accessTokenRef));
            if (stored.auth.refreshTokenRef) {
              yield* Effect.either(deleteSecretMaterial(stored.auth.refreshTokenRef));
            }
          }
        }),
    },
    localConfig: {
      toConfigSource: ({ source, stored }) =>
        pluginLocalConfigSourceFromConfig({
          source,
          config: stored,
        }),
      recoverStored: ({ config }) =>
        mcpStoredSourceDataFromLocalConfig(config),
    },
    catalog: {
      kind: "imported",
      identity: ({ source }) => ({
        kind: "mcp",
        sourceId: source.id,
      }),
      sync: ({ source, stored }) =>
        Effect.gen(function* () {
          if (stored === null) {
            return yield* runtimeEffectError(
              "plugins/mcp/sdk",
              `MCP source storage missing for ${source.id}`,
            );
          }

          const connector = yield* createStoredMcpConnector({
            scopeId: source.scopeId,
            sourceId: source.id,
            stored,
            storage: options.storage,
          });
          const discovered = yield* discoverMcpToolsFromConnector({
            connect: connector,
            namespace:
              source.namespace
              ?? deriveMcpNamespace({
                name: source.name,
                endpoint: stored.endpoint,
                command: stored.command,
              })
              ?? undefined,
            sourceKey: source.id,
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          );
          const manifestJson = JSON.stringify(discovered.manifest);
          const now = Date.now();

          return createSourceCatalogSyncResult({
            fragment: createMcpCatalogFragment({
              source,
              documents: [
                {
                  documentKind: "mcp_manifest",
                  documentKey: mcpDocumentKey(stored),
                  contentText: manifestJson,
                  fetchedAt: now,
                },
              ],
              operations: discovered.manifest.tools.map((entry) =>
                mcpCatalogOperationFromManifestEntry({
                  entry,
                  server: discovered.manifest.server,
                })
              ),
            }),
            importMetadata: {
              ...createCatalogImportMetadata({
                source,
                pluginKey: "mcp",
              }),
              importerVersion: "ir.v1.mcp",
            },
            sourceHash: contentHash(manifestJson),
          });
        }),
      invoke: (input) =>
        Effect.gen(function* () {
          if (input.stored === null) {
            return yield* runtimeEffectError(
              "plugins/mcp/sdk",
              `MCP source storage missing for ${input.source.id}`,
            );
          }

          const providerData = decodeProviderData(
            input.executable.binding,
          ) as McpExecutableBinding;
          const connector = createPooledMcpConnector({
            connect: yield* createStoredMcpConnector({
              scopeId: input.source.scopeId,
              sourceId: input.source.id,
              stored: input.stored,
              storage: options.storage,
            }),
            runId:
              typeof input.context?.runId === "string" && input.context.runId.length > 0
                ? input.context.runId
                : undefined,
            sourceKey: input.source.id,
          });
          const manifest = {
            version: 2 as const,
            server: providerData.server as McpServerMetadata | null,
            tools: [
              {
                toolId: providerData.toolId,
                toolName: providerData.toolName,
                displayTitle: providerData.displayTitle,
                title: providerData.title,
                description: providerData.description,
                annotations: providerData.annotations as McpToolManifestEntry["annotations"],
                execution: providerData.execution as McpToolManifestEntry["execution"],
                icons: providerData.icons as McpToolManifestEntry["icons"],
                meta: providerData.meta,
                rawTool: providerData.rawTool,
                inputSchema: input.descriptor.contract?.inputSchema,
                outputSchema: input.descriptor.contract?.outputSchema,
              },
            ],
          };
          const tools = createMcpToolsFromManifest({
            manifest,
            connect: connector,
            namespace: input.source.namespace ?? undefined,
            sourceKey: input.source.id,
          });
          const toolPath = joinToolPath(input.source.namespace ?? undefined, providerData.toolId);
          const entry = (
            tools[toolPath]
            ?? tools[providerData.toolId]
            ?? tools[providerData.toolName]
          ) as ToolInput | undefined;
          const definition =
            entry && typeof entry === "object" && entry !== null && "tool" in entry
              ? entry.tool
              : entry;

          if (!definition) {
            return yield* runtimeEffectError(
              "plugins/mcp/sdk",
              `Missing MCP tool definition for ${providerData.toolName}`,
            );
          }

          const inputShape = input.executable.projection.callShapeId
            ? input.catalog.symbols[input.executable.projection.callShapeId]
            : undefined;
          const payload =
            inputShape?.kind === "shape" && inputShape.node.type !== "object"
              ? asRecord(input.args).input
              : input.args;
          const executionContext: ToolExecutionContext | undefined =
            input.onElicitation
              ? {
                  path: input.descriptor.path as ToolPath,
                  sourceKey: input.source.id,
                  metadata: {
                    sourceKey: input.source.id,
                    interaction: input.descriptor.interaction,
                    contract: {
                      ...(input.descriptor.contract?.inputSchema !== undefined
                        ? { inputSchema: input.descriptor.contract.inputSchema }
                        : {}),
                      ...(input.descriptor.contract?.outputSchema !== undefined
                        ? { outputSchema: input.descriptor.contract.outputSchema }
                        : {}),
                    },
                    pluginKind: input.descriptor.pluginKind,
                    pluginData: input.descriptor.pluginData,
                  },
                  invocation: input.context,
                  onElicitation: input.onElicitation,
                }
              : undefined;
          const result = yield* Effect.tryPromise({
            try: async () =>
              await definition.execute(asRecord(payload), executionContext),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });
          const resultRecord = asRecord(result);
          const isError = resultRecord.isError === true;

          return {
            data: isError ? null : (result ?? null),
            error: isError ? result : null,
            headers: {},
            status: null,
          };
        }),
    },
  },
  tools: [
    {
      name: "discoverSource",
      description: "Probe an MCP endpoint before creating a source.",
      inputSchema: McpDiscoverInputSchema,
      outputSchema: McpDiscoverResultSchema,
      execute: ({ args }) =>
        Effect.gen(function* () {
          const normalizedUrl = normalizeSourceDiscoveryUrl(args.endpoint);
          const discovered = yield* detectMcpSource({
            normalizedUrl,
            headers: probeHeadersFromAuth(args.probeAuth ?? null),
          });
          return discovered satisfies SourceDiscoveryResult | null;
        }),
    },
    {
      name: "getSourceConfig",
      description: "Load the saved configuration for an MCP source.",
      inputSchema: McpSourceIdInputSchema,
      outputSchema: McpSourceConfigPayloadSchema,
      execute: ({ args, source }) => source.getSourceConfig(args.sourceId),
    },
    {
      name: "createSource",
      description: "Create an MCP source.",
      inputSchema: McpConnectInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.createSource(args),
    },
    {
      name: "updateSource",
      description: "Update an MCP source configuration.",
      inputSchema: McpUpdateSourceInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.updateSource(args),
    },
    {
      name: "removeSource",
      description: "Remove an MCP source and its stored plugin data.",
      inputSchema: McpSourceIdInputSchema,
      outputSchema: Schema.Boolean,
      execute: ({ args, source }) => source.removeSource(args.sourceId),
    },
    {
      name: "startOAuth",
      description: "Start an MCP OAuth flow for a source connection.",
      inputSchema: McpStartOAuthInputSchema,
      outputSchema: McpStartOAuthResultSchema,
      execute: ({ args }) =>
        Effect.gen(function* () {
          const endpoint = resolveMcpEndpoint({
            endpoint: args.endpoint.trim(),
            queryParams: args.queryParams,
          });
          const sessionId = `mcp_oauth_${crypto.randomUUID()}`;
          const started = yield* startMcpOAuthAuthorization({
            endpoint,
            redirectUrl: args.redirectUrl,
            state: sessionId,
          });

          yield* options.oauthSessions.put({
            sessionId,
            value: decodeSession({
              endpoint,
              redirectUrl: args.redirectUrl,
              codeVerifier: started.codeVerifier,
              resourceMetadataUrl: started.resourceMetadataUrl,
              authorizationServerUrl: started.authorizationServerUrl,
              resourceMetadata: started.resourceMetadata,
              authorizationServerMetadata: started.authorizationServerMetadata,
              clientInformation: started.clientInformation,
            }),
          });

          return {
            sessionId,
            authorizationUrl: started.authorizationUrl,
          };
        }),
    },
    {
      name: "completeOAuth",
      description: "Complete an MCP OAuth callback and return the connected auth payload.",
      inputSchema: McpCompleteOAuthInputSchema,
      outputSchema: McpOAuthPopupResultSchema,
      execute: ({ args }) =>
        Effect.gen(function* () {
          if (args.error) {
            return yield* runtimeEffectError(
              "plugins/mcp/sdk",
              args.errorDescription || args.error || "MCP OAuth failed",
            );
          }
          if (!args.code) {
            return yield* runtimeEffectError(
              "plugins/mcp/sdk",
              "Missing MCP OAuth code.",
            );
          }

          const session = yield* options.oauthSessions.get(args.state);
          if (session === null) {
            return yield* runtimeEffectError(
              "plugins/mcp/sdk",
              `MCP OAuth session not found: ${args.state}`,
            );
          }

          const exchanged = yield* exchangeMcpOAuthAuthorizationCode({
            session,
            code: args.code,
          });
          const storeSecretMaterial = yield* SecretMaterialStorerService;
          const accessTokenRef = yield* storeSecretMaterial({
            purpose: "oauth_access_token",
            value: exchanged.tokens.access_token,
            name: "MCP Access Token",
          });
          const refreshTokenRef = exchanged.tokens.refresh_token
            ? yield* storeSecretMaterial({
                purpose: "oauth_refresh_token",
                value: exchanged.tokens.refresh_token,
                name: "MCP Refresh Token",
              })
            : null;

          if (options.oauthSessions.remove) {
            yield* options.oauthSessions.remove(args.state);
          }

          return {
            type: "executor:oauth-result" as const,
            ok: true as const,
            sessionId: args.state,
            auth: {
              kind: "oauth2" as const,
              redirectUri: session.redirectUrl,
              accessTokenRef,
              refreshTokenRef,
              tokenType: exchanged.tokens.token_type ?? "Bearer",
              expiresAt:
                typeof exchanged.tokens.expires_in === "number"
                  ? Date.now() + exchanged.tokens.expires_in * 1000
                  : null,
              scope: exchanged.tokens.scope ?? null,
              resourceMetadataUrl: session.resourceMetadataUrl,
              authorizationServerUrl: session.authorizationServerUrl,
              resourceMetadata: session.resourceMetadata,
              authorizationServerMetadata: session.authorizationServerMetadata,
              clientInformation: session.clientInformation,
            },
          };
        }),
    },
  ] as const,
  extendExecutor: ({ source, executor }) => {
    const provideRuntime = <A>(
      effect: Effect.Effect<A, Error, any>,
    ): Effect.Effect<A, Error, never> =>
      provideExecutorRuntime(effect, executor.runtime);

    return {
      discoverSource: (input) =>
        provideRuntime(
          Effect.gen(function* () {
            const normalizedUrl = normalizeSourceDiscoveryUrl(input.endpoint);
            const discovered = yield* detectMcpSource({
              normalizedUrl,
              headers: probeHeadersFromAuth(input.probeAuth ?? null),
            });
            return discovered satisfies SourceDiscoveryResult | null;
          }),
        ),
      getSourceConfig: (sourceId) =>
        provideRuntime(source.getSourceConfig(sourceId)),
      createSource: (input) =>
        provideRuntime(source.createSource(input)),
      updateSource: (input) =>
        provideRuntime(source.updateSource(input)),
      removeSource: (sourceId) =>
        provideRuntime(source.removeSource(sourceId)),
      startOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
        const endpoint = resolveMcpEndpoint({
          endpoint: input.endpoint.trim(),
          queryParams: input.queryParams,
        });
        const sessionId = `mcp_oauth_${crypto.randomUUID()}`;
        const started = yield* startMcpOAuthAuthorization({
          endpoint,
          redirectUrl: input.redirectUrl,
          state: sessionId,
        });

        yield* options.oauthSessions.put({
          sessionId,
          value: decodeSession({
            endpoint,
            redirectUrl: input.redirectUrl,
            codeVerifier: started.codeVerifier,
            resourceMetadataUrl: started.resourceMetadataUrl,
            authorizationServerUrl: started.authorizationServerUrl,
            resourceMetadata: started.resourceMetadata,
            authorizationServerMetadata: started.authorizationServerMetadata,
            clientInformation: started.clientInformation,
          }),
        });

        return {
          sessionId,
          authorizationUrl: started.authorizationUrl,
        };
          }),
        ),
      completeOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
        if (input.error) {
          return yield* runtimeEffectError(
            "plugins/mcp/sdk",
            input.errorDescription || input.error || "MCP OAuth failed",
          );
        }
        if (!input.code) {
          return yield* runtimeEffectError(
            "plugins/mcp/sdk",
            "Missing MCP OAuth code.",
          );
        }

        const session = yield* options.oauthSessions.get(input.state);
        if (session === null) {
          return yield* runtimeEffectError(
            "plugins/mcp/sdk",
            `MCP OAuth session not found: ${input.state}`,
          );
        }

        const exchanged = yield* exchangeMcpOAuthAuthorizationCode({
          session,
          code: input.code,
        });
        const storeSecretMaterial = yield* SecretMaterialStorerService;
        const accessTokenRef = yield* storeSecretMaterial({
          purpose: "oauth_access_token",
          value: exchanged.tokens.access_token,
          name: "MCP Access Token",
        });
        const refreshTokenRef = exchanged.tokens.refresh_token
          ? yield* storeSecretMaterial({
              purpose: "oauth_refresh_token",
              value: exchanged.tokens.refresh_token,
              name: "MCP Refresh Token",
            })
          : null;

        if (options.oauthSessions.remove) {
          yield* options.oauthSessions.remove(input.state);
        }

        return {
          type: "executor:oauth-result",
          ok: true,
          sessionId: input.state,
          auth: {
            kind: "oauth2",
            redirectUri: session.redirectUrl,
            accessTokenRef,
            refreshTokenRef,
            tokenType: exchanged.tokens.token_type ?? "Bearer",
            expiresAt: expiresAtFromTokens(exchanged.tokens),
            scope: exchanged.tokens.scope ?? null,
            resourceMetadataUrl:
              exchanged.resourceMetadataUrl ?? session.resourceMetadataUrl,
            authorizationServerUrl:
              exchanged.authorizationServerUrl ?? session.authorizationServerUrl,
            resourceMetadata:
              exchanged.resourceMetadata ?? session.resourceMetadata,
            authorizationServerMetadata:
              exchanged.authorizationServerMetadata
              ?? session.authorizationServerMetadata,
            clientInformation:
              exchanged.clientInformation ?? session.clientInformation,
          },
        };
          }),
      ),
    };
  },
});
