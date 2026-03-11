import {
  createSdkMcpConnector,
  discoverMcpToolsFromConnector,
  type McpDiscoveryElicitationContext,
} from "@executor/codemode-mcp";
import {
  SqlControlPlaneRowsService,
  type SqlControlPlaneRows,
} from "#persistence";
import {
  AccountId,
  type CredentialSlot,
  ExecutionIdSchema,
  McpSourceAuthSessionDataJsonSchema,
  type McpSourceAuthSessionData,
  type SecretMaterialPurpose,
  Source,
  type SourceImportAuthPolicy,
  type SourceTransport,
  SourceAuthSession,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  SourceSchema,
  type SecretRef,
  type StringMap,
  type WorkspaceId,
} from "#schema";
import * as Context from "effect/Context";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import {
  LiveExecutionManagerService,
  type LiveExecutionManager,
} from "./live-execution";
import {
  exchangeMcpOAuthAuthorizationCode,
  startMcpOAuthAuthorization,
} from "./mcp-oauth";
import {
  createSourceFromPayload,
  updateSourceFromPayload,
} from "./source-definitions";
import {
  hasSourceAdapterFamily,
  sourceBindingStateFromSource,
} from "./source-adapters";
import { isSourceCredentialRequiredError } from "./source-adapters/shared";
import {
  createDefaultSecretMaterialResolver,
  createDefaultSecretMaterialStorer,
  type ResolveSecretMaterial,
  type StoreSecretMaterial,
} from "./secret-material-providers";
import {
  persistMcpRecipeMaterializationFromManifest,
  syncSourceMaterialization,
} from "./source-materialization";
import {
  loadSourceById,
  loadSourcesInWorkspace,
  persistSource,
} from "./source-store";

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const defaultSourceNameFromEndpoint = (endpoint: string): string => {
  const url = new URL(endpoint);
  return url.hostname;
};

const defaultNamespaceFromName = (name: string): string => {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

  return normalized.length > 0 ? normalized : "source";
};

const resolveSourceCredentialOauthCompleteUrl = (input: {
  baseUrl: string;
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}): string =>
  new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/sources/${encodeURIComponent(input.sourceId)}/credentials/oauth/complete`,
    input.baseUrl,
  ).toString();

const resolveSourceOAuthCallbackUrl = (input: {
  baseUrl: string;
}): string =>
  new URL(
    "/v1/oauth/source-auth/callback",
    input.baseUrl,
  ).toString();

const normalizeEndpoint = (endpoint: string): string => {
  const url = new URL(endpoint.trim());
  return url.toString();
};

const SourceOAuthSessionStatePayloadSchema = Schema.Struct({
  kind: Schema.Literal("source_oauth"),
  nonce: Schema.String,
  displayName: Schema.NullOr(Schema.String),
});

const encodeSourceOAuthSessionStatePayload = Schema.encodeSync(
  Schema.parseJson(SourceOAuthSessionStatePayloadSchema),
);

const decodeSourceOAuthSessionStatePayloadOption = Schema.decodeUnknownOption(
  Schema.parseJson(SourceOAuthSessionStatePayloadSchema),
);

const createSourceOAuthSessionState = (input: {
  displayName?: string | null;
}): string =>
  encodeSourceOAuthSessionStatePayload({
    kind: "source_oauth",
    nonce: crypto.randomUUID(),
    displayName: trimOrNull(input.displayName),
  });

const readSourceOAuthSessionDisplayName = (state: string): string | null => {
  const decoded = decodeSourceOAuthSessionStatePayloadOption(state);
  return Option.isSome(decoded) ? trimOrNull(decoded.value.displayName) : null;
};

const resolveSourceOAuthSecretName = (input: {
  displayName?: string | null;
  endpoint: string;
}): string => {
  const sourceName = trimOrNull(input.displayName) ?? defaultSourceNameFromEndpoint(input.endpoint);
  return /\boauth\b/i.test(sourceName) ? sourceName : `${sourceName} OAuth`;
};

const probeMcpSourceWithoutAuth = (
  source: Source,
  mcpDiscoveryElicitation?: McpDiscoveryElicitationContext,
) =>
  Effect.gen(function* () {
    if (source.kind !== "mcp") {
      return yield* Effect.fail(new Error(`Expected MCP source, received ${source.kind}`));
    }
    const bindingState = yield* sourceBindingStateFromSource(source);

    const connector = yield* Effect.try({
      try: () =>
        createSdkMcpConnector({
          endpoint: source.endpoint,
          transport: bindingState.transport ?? undefined,
          queryParams: bindingState.queryParams ?? undefined,
          headers: bindingState.headers ?? undefined,
        }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });

    return yield* discoverMcpToolsFromConnector({
      connect: connector,
      namespace: source.namespace ?? defaultNamespaceFromName(source.name),
      sourceKey: source.id,
      mcpDiscoveryElicitation,
    });
  });

export const createTerminalSourceAuthSessionPatch = (input: {
  sessionDataJson: string;
  status: Extract<SourceAuthSession["status"], "completed" | "failed" | "cancelled">;
  now: number;
  errorText: string | null;
}) => ({
  status: input.status,
  errorText: input.errorText,
  completedAt: input.now,
  updatedAt: input.now,
  sessionDataJson: input.sessionDataJson,
}) satisfies Partial<SourceAuthSession>;

const encodeMcpSourceAuthSessionData = (
  sessionData: McpSourceAuthSessionData,
): string => Schema.encodeSync(McpSourceAuthSessionDataJsonSchema)(sessionData);

const decodeMcpSourceAuthSessionDataJson = Schema.decodeUnknownEither(
  McpSourceAuthSessionDataJsonSchema,
);

const decodeMcpSourceAuthSessionData = (
  session: Pick<SourceAuthSession, "id" | "providerKind" | "sessionDataJson">,
): McpSourceAuthSessionData => {
  if (session.providerKind !== "mcp_oauth") {
    throw new Error(`Unsupported source auth provider for session ${session.id}`);
  }

  const decoded = decodeMcpSourceAuthSessionDataJson(session.sessionDataJson);
  if (Either.isLeft(decoded)) {
    throw new Error(
      `Invalid source auth session data for ${session.id}: ${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
    );
  }

  return decoded.right;
};

const mergeMcpSourceAuthSessionData = (input: {
  session: Pick<SourceAuthSession, "id" | "providerKind" | "sessionDataJson">;
  patch: Partial<McpSourceAuthSessionData>;
}): string => {
  const existing = decodeMcpSourceAuthSessionData(input.session);
  return encodeMcpSourceAuthSessionData({
    ...existing,
    ...input.patch,
  });
};


const completeLiveInteraction = (input: {
  liveExecutionManager: LiveExecutionManager;
  session: SourceAuthSession;
  response: {
    action: "accept" | "cancel";
    reason?: string;
  };
}) =>
  Effect.gen(function* () {
    if (input.session.executionId === null) {
      return;
    }

    yield* input.liveExecutionManager.resolveInteraction({
      executionId: input.session.executionId,
      response:
        input.response.action === "accept"
          ? { action: "accept" }
          : {
              action: "cancel",
              ...(input.response.reason
                ? {
                    content: {
                      reason: input.response.reason,
                    },
                  }
                : {}),
            },
    });
  });

const updateSourceStatus = (rows: SqlControlPlaneRows, source: Source, input: {
  actorAccountId?: AccountId | null;
  status: Source["status"];
  lastError?: string | null;
  auth?: Source["auth"];
  importAuth?: Source["importAuth"];
}) =>
  Effect.gen(function* () {
    const latest = yield* loadSourceById(rows, {
      workspaceId: source.workspaceId,
      sourceId: source.id,
      actorAccountId: input.actorAccountId,
    });

    return yield* persistSource(rows, {
      ...latest,
      status: input.status,
      lastError: input.lastError ?? null,
      auth: input.auth ?? latest.auth,
      importAuth: input.importAuth ?? latest.importAuth,
      updatedAt: Date.now(),
    }, {
      actorAccountId: input.actorAccountId,
    });
  });

export type ExecutorSourceAddResult =
  | {
      kind: "connected";
      source: Source;
    }
  | {
      kind: "credential_required";
      source: Source;
      credentialSlot: CredentialSlot;
    }
  | {
      kind: "oauth_required";
      source: Source;
      sessionId: SourceAuthSession["id"];
      authorizationUrl: string;
    };

export type ExecutorHttpSourceAuthInput =
  | {
      kind: "none";
    }
  | {
      kind: "bearer";
      headerName?: string | null;
      prefix?: string | null;
      token?: string | null;
      tokenRef?: SecretRef | null;
    }
  | {
      kind: "oauth2";
      headerName?: string | null;
      prefix?: string | null;
      accessToken?: string | null;
      accessTokenRef?: SecretRef | null;
      refreshToken?: string | null;
      refreshTokenRef?: SecretRef | null;
    };

export type ExecutorAddSourceInput =
  | {
      kind?: "mcp";
      workspaceId: WorkspaceId;
      actorAccountId?: AccountId | null;
      executionId: SourceAuthSession["executionId"];
      interactionId: SourceAuthSession["interactionId"];
      endpoint: string;
      name?: string | null;
      namespace?: string | null;
    }
  | {
      kind: "openapi";
      workspaceId: WorkspaceId;
      actorAccountId?: AccountId | null;
      executionId: SourceAuthSession["executionId"];
      interactionId: SourceAuthSession["interactionId"];
      endpoint: string;
      specUrl: string;
      name?: string | null;
      namespace?: string | null;
      importAuthPolicy?: SourceImportAuthPolicy | null;
      importAuth?: ExecutorHttpSourceAuthInput | null;
      auth?: ExecutorHttpSourceAuthInput | null;
    }
  | {
      kind: "graphql";
      workspaceId: WorkspaceId;
      actorAccountId?: AccountId | null;
      executionId: SourceAuthSession["executionId"];
      interactionId: SourceAuthSession["interactionId"];
      endpoint: string;
      name?: string | null;
      namespace?: string | null;
      importAuthPolicy?: SourceImportAuthPolicy | null;
      importAuth?: ExecutorHttpSourceAuthInput | null;
      auth?: ExecutorHttpSourceAuthInput | null;
    };

export type ConnectMcpSourceInput = {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  sourceId?: Source["id"] | null;
  endpoint: string;
  name?: string | null;
  namespace?: string | null;
  enabled?: boolean;
  transport?: SourceTransport;
  queryParams?: StringMap | null;
  headers?: StringMap | null;
  baseUrl?: string | null;
};

export type McpSourceConnectResult = Extract<ExecutorSourceAddResult, {
  kind: "connected" | "oauth_required";
}>;

export type SourceOAuthProviderInput = {
  kind: "mcp";
  endpoint: string;
  transport?: SourceTransport;
  queryParams?: StringMap | null;
  headers?: StringMap | null;
};

export type StartSourceOAuthSessionInput = {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  provider: SourceOAuthProviderInput;
  baseUrl?: string | null;
  displayName?: string | null;
};

export type StartSourceOAuthSessionResult = {
  sessionId: SourceAuthSession["id"];
  authorizationUrl: string;
};

export type CompleteSourceOAuthSessionResult = {
  sessionId: SourceAuthSession["id"];
  auth: Extract<Source["auth"], { kind: "oauth2" }>;
};

const materializeSecretRefInput = (input: {
  rawValue?: string | null;
  ref?: SecretRef | null;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<SecretRef | null, Error, never> =>
  Effect.gen(function* () {
    const rawValue = trimOrNull(input.rawValue);
    if (rawValue !== null) {
      return yield* input.storeSecretMaterial({
        purpose: "auth_material",
        value: rawValue,
      });
    }

    const providerId = trimOrNull(input.ref?.providerId);
    const handle = trimOrNull(input.ref?.handle);
    if (providerId === null || handle === null) {
      return null;
    }

    return {
      providerId,
      handle,
    } satisfies SecretRef;
  });

const materializeExecutorHttpAuth = (input: {
  existing?: Source;
  auth?: ExecutorHttpSourceAuthInput | null;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<Source["auth"], Error, never> =>
  Effect.gen(function* () {
    const existing = input.existing;

    if (input.auth === undefined && existing && hasSourceAdapterFamily(existing.kind, "http_api")) {
      return existing.auth;
    }

    const auth = input.auth ?? { kind: "none" } satisfies ExecutorHttpSourceAuthInput;
    if (auth.kind === "none") {
      return { kind: "none" } satisfies Source["auth"];
    }

    const headerName = trimOrNull(auth.headerName) ?? "Authorization";
    const prefix = auth.prefix ?? "Bearer ";

    if (auth.kind === "bearer") {
      const token = trimOrNull(auth.token);
      const tokenRefInput = auth.tokenRef ?? null;

      if (
        token === null
        && tokenRefInput === null
        && existing
        && hasSourceAdapterFamily(existing.kind, "http_api")
        && existing.auth.kind === "bearer"
      ) {
        return existing.auth;
      }

      const tokenRef = yield* materializeSecretRefInput({
        rawValue: token,
        ref: tokenRefInput,
        storeSecretMaterial: input.storeSecretMaterial,
      });
      if (tokenRef === null) {
        return yield* Effect.fail(
          new Error("Bearer auth requires token or tokenRef"),
        );
      }

      return {
        kind: "bearer",
        headerName,
        prefix,
        token: tokenRef,
      } satisfies Source["auth"];
    }

    if (
      trimOrNull(auth.accessToken) === null
      && auth.accessTokenRef == null
      && trimOrNull(auth.refreshToken) === null
      && auth.refreshTokenRef == null
      && existing
      && hasSourceAdapterFamily(existing.kind, "http_api")
      && existing.auth.kind === "oauth2"
    ) {
      return existing.auth;
    }

    const accessTokenRef = yield* materializeSecretRefInput({
      rawValue: auth.accessToken,
      ref: auth.accessTokenRef ?? null,
      storeSecretMaterial: input.storeSecretMaterial,
    });
    if (accessTokenRef === null) {
      return yield* Effect.fail(
        new Error("OAuth2 auth requires accessToken or accessTokenRef"),
      );
    }

    const refreshTokenRef = yield* materializeSecretRefInput({
      rawValue: auth.refreshToken,
      ref: auth.refreshTokenRef ?? null,
      storeSecretMaterial: input.storeSecretMaterial,
    });

    return {
      kind: "oauth2",
      headerName,
      prefix,
      accessToken: accessTokenRef,
      refreshToken: refreshTokenRef,
    } satisfies Source["auth"];
  });

const materializeExecutorHttpImportAuth = (input: {
  sourceKind: "openapi" | "graphql";
  existing?: Source;
  importAuthPolicy?: SourceImportAuthPolicy | null;
  importAuth?: ExecutorHttpSourceAuthInput | null;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<{
  importAuthPolicy: SourceImportAuthPolicy;
  importAuth: Source["importAuth"];
}, Error, never> =>
  Effect.gen(function* () {
    const adapterDefault = input.sourceKind === "openapi" || input.sourceKind === "graphql"
      ? "reuse_runtime"
      : "none";
    const importAuthPolicy = input.importAuthPolicy ?? input.existing?.importAuthPolicy ?? adapterDefault;

    if (importAuthPolicy === "none" || importAuthPolicy === "reuse_runtime") {
      return {
        importAuthPolicy,
        importAuth: { kind: "none" } satisfies Source["importAuth"],
      };
    }

    if (
      input.importAuth === undefined
      && input.existing
      && input.existing.importAuthPolicy === "separate"
    ) {
      return {
        importAuthPolicy,
        importAuth: input.existing.importAuth,
      };
    }

    const importAuth = yield* materializeExecutorHttpAuth({
      existing: undefined,
      auth: input.importAuth ?? { kind: "none" },
      storeSecretMaterial: input.storeSecretMaterial,
    });

    return {
      importAuthPolicy,
      importAuth,
    };
  });

const shouldPromptForExecutorHttpRuntimeCredentialSetup = (input: {
  existing?: Source;
  explicitAuthProvided: boolean;
  auth: Source["auth"];
}): boolean =>
  !input.explicitAuthProvided
  && input.auth.kind === "none"
  && (input.existing?.auth.kind ?? "none") === "none";

const connectMcpSourceInternal = (input: {
  rows: SqlControlPlaneRows;
  getLocalServerBaseUrl?: () => string | undefined;
  baseUrl?: string | null;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  sourceId?: Source["id"] | null;
  executionId?: SourceAuthSession["executionId"];
  interactionId?: SourceAuthSession["interactionId"];
  endpoint: string;
  name?: string | null;
  namespace?: string | null;
  enabled?: boolean;
  transport?: SourceTransport;
  queryParams?: StringMap | null;
  headers?: StringMap | null;
  mcpDiscoveryElicitation?: McpDiscoveryElicitationContext;
  resolveSecretMaterial: ResolveSecretMaterial;
}): Effect.Effect<McpSourceConnectResult, Error, never> =>
  Effect.gen(function* () {
    const normalizedEndpoint = normalizeEndpoint(input.endpoint);
    const existing = yield* (
      input.sourceId
        ? loadSourceById(input.rows, {
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            actorAccountId: input.actorAccountId,
          }).pipe(
            Effect.flatMap((source) =>
              hasSourceAdapterFamily(source.kind, "mcp")
                ? Effect.succeed(source)
                : Effect.fail(new Error(`Expected MCP source, received ${source.kind}`)),
            ),
          )
        : loadSourcesInWorkspace(input.rows, input.workspaceId, {
            actorAccountId: input.actorAccountId,
          }).pipe(
            Effect.map((sources) =>
              sources.find(
                (source) =>
                  hasSourceAdapterFamily(source.kind, "mcp")
                  && normalizeEndpoint(source.endpoint) === normalizedEndpoint,
              ),
            ),
          )
    );

    const chosenName =
      trimOrNull(input.name) ?? existing?.name ?? defaultSourceNameFromEndpoint(normalizedEndpoint);
    const chosenNamespace =
      trimOrNull(input.namespace)
      ?? existing?.namespace
      ?? defaultNamespaceFromName(chosenName);
    const chosenEnabled = input.enabled ?? existing?.enabled ?? true;
    const existingBinding = existing
      ? yield* sourceBindingStateFromSource(existing)
      : null;
    const chosenTransport = input.transport ?? existingBinding?.transport ?? "auto";
    const chosenQueryParams =
      input.queryParams !== undefined ? input.queryParams : (existingBinding?.queryParams ?? null);
    const chosenHeaders =
      input.headers !== undefined ? input.headers : (existingBinding?.headers ?? null);
    const now = Date.now();

    const draftSource = existing
      ? yield* updateSourceFromPayload({
          source: existing,
          payload: {
            name: chosenName,
            endpoint: normalizedEndpoint,
            namespace: chosenNamespace,
            status: "probing",
            enabled: chosenEnabled,
            binding: {
              transport: chosenTransport,
              queryParams: chosenQueryParams,
              headers: chosenHeaders,
            },
            importAuthPolicy: "reuse_runtime",
            importAuth: { kind: "none" },
            auth: { kind: "none" },
            lastError: null,
          },
          now,
        })
      : yield* createSourceFromPayload({
          workspaceId: input.workspaceId,
          sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
          payload: {
            name: chosenName,
            kind: "mcp",
            endpoint: normalizedEndpoint,
            namespace: chosenNamespace,
            status: "probing",
            enabled: chosenEnabled,
            binding: {
              transport: chosenTransport,
              queryParams: chosenQueryParams,
              headers: chosenHeaders,
            },
            importAuthPolicy: "reuse_runtime",
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        });

    const persistedDraft = yield* persistSource(input.rows, draftSource, {
      actorAccountId: input.actorAccountId,
    });
    yield* syncSourceMaterialization({
      rows: input.rows,
      source: persistedDraft,
      resolveSecretMaterial: input.resolveSecretMaterial,
    });

    const discovered = yield* Effect.either(
      probeMcpSourceWithoutAuth(
        persistedDraft,
        input.mcpDiscoveryElicitation,
      ),
    );

    const connectedResult = yield* Either.match(discovered, {
      onLeft: () => Effect.succeed(null),
      onRight: (result) =>
        Effect.gen(function* () {
          const connected = yield* updateSourceStatus(input.rows, persistedDraft, {
            actorAccountId: input.actorAccountId,
            status: "connected",
            lastError: null,
            auth: { kind: "none" },
          });
          const indexed = yield* Effect.either(
            persistMcpRecipeMaterializationFromManifest({
              rows: input.rows,
              source: connected,
              manifestEntries: result.manifest.tools,
            }),
          );

          return yield* Either.match(indexed, {
            onLeft: (error) =>
              updateSourceStatus(input.rows, connected, {
                actorAccountId: input.actorAccountId,
                status: "error",
                lastError: error.message,
              }).pipe(
                Effect.zipRight(Effect.fail(error)),
              ),
            onRight: () =>
              Effect.succeed({
                kind: "connected",
                source: connected,
              } satisfies McpSourceConnectResult),
          });
        }),
    });

    if (connectedResult) {
      return connectedResult;
    }

    const localServerBaseUrl = trimOrNull(input.baseUrl) ?? input.getLocalServerBaseUrl?.() ?? null;
    if (!localServerBaseUrl) {
      return yield* Effect.fail(
        new Error("Local executor server base URL is unavailable for source credential setup"),
      );
    }

    const sessionId = SourceAuthSessionIdSchema.make(`src_auth_${crypto.randomUUID()}`);
    const state = crypto.randomUUID();
    const redirectUrl = resolveSourceCredentialOauthCompleteUrl({
      baseUrl: localServerBaseUrl,
      workspaceId: input.workspaceId,
      sourceId: persistedDraft.id,
    });
    const oauthStart = yield* startMcpOAuthAuthorization({
      endpoint: normalizedEndpoint,
      redirectUrl,
      state,
    });

    const authRequiredSource = yield* updateSourceStatus(input.rows, persistedDraft, {
      actorAccountId: input.actorAccountId,
      status: "auth_required",
      lastError: null,
    });

    const sessionNow = Date.now();
    yield* input.rows.sourceAuthSessions.upsert({
      id: sessionId,
      workspaceId: input.workspaceId,
      sourceId: authRequiredSource.id,
      actorAccountId: input.actorAccountId ?? null,
      credentialSlot: "runtime",
      executionId: input.executionId ?? null,
      interactionId: input.interactionId ?? null,
      providerKind: "mcp_oauth",
      status: "pending",
      state,
      sessionDataJson: encodeMcpSourceAuthSessionData({
        kind: "mcp_oauth",
        endpoint: normalizedEndpoint,
        redirectUri: redirectUrl,
        scope: null,
        resourceMetadataUrl: oauthStart.resourceMetadataUrl,
        authorizationServerUrl: oauthStart.authorizationServerUrl,
        resourceMetadata: oauthStart.resourceMetadata,
        authorizationServerMetadata: oauthStart.authorizationServerMetadata,
        clientInformation: oauthStart.clientInformation,
        codeVerifier: oauthStart.codeVerifier,
        authorizationUrl: oauthStart.authorizationUrl,
      }),
      errorText: null,
      completedAt: null,
      createdAt: sessionNow,
      updatedAt: sessionNow,
    });

    return {
      kind: "oauth_required",
      source: authRequiredSource,
      sessionId,
      authorizationUrl: oauthStart.authorizationUrl,
    } satisfies McpSourceConnectResult;
  });

const addExecutorHttpSource = (input: {
  rows: SqlControlPlaneRows;
  sourceInput: Extract<ExecutorAddSourceInput, { kind: "openapi" | "graphql" }>;
  storeSecretMaterial: StoreSecretMaterial;
  resolveSecretMaterial: ResolveSecretMaterial;
}): Effect.Effect<ExecutorSourceAddResult, Error, never> =>
  Effect.gen(function* () {
    const normalizedEndpoint = normalizeEndpoint(input.sourceInput.endpoint);
    const normalizedSpecUrl = input.sourceInput.kind === "openapi"
      ? normalizeEndpoint(input.sourceInput.specUrl)
      : null;
    const existingSources = yield* loadSourcesInWorkspace(
      input.rows,
      input.sourceInput.workspaceId,
      {
        actorAccountId: input.sourceInput.actorAccountId,
      },
    );
    const existing = existingSources.find((source) => {
      if (source.kind !== input.sourceInput.kind) {
        return false;
      }

      if (normalizeEndpoint(source.endpoint) !== normalizedEndpoint) {
        return false;
      }

      if (input.sourceInput.kind === "openapi") {
        const bindingState = Effect.runSync(sourceBindingStateFromSource(source));
        return trimOrNull(bindingState.specUrl) === normalizedSpecUrl;
      }

      return true;
    });

    const chosenName =
      trimOrNull(input.sourceInput.name)
      ?? existing?.name
      ?? defaultSourceNameFromEndpoint(normalizedEndpoint);
    const chosenNamespace =
      trimOrNull(input.sourceInput.namespace)
      ?? existing?.namespace
      ?? defaultNamespaceFromName(chosenName);
    const existingBinding = existing
      ? yield* sourceBindingStateFromSource(existing)
      : null;
    const now = Date.now();

    const auth = yield* materializeExecutorHttpAuth({
      existing,
      auth: input.sourceInput.auth,
      storeSecretMaterial: input.storeSecretMaterial,
    });
    const importAuth = yield* materializeExecutorHttpImportAuth({
      sourceKind: input.sourceInput.kind,
      existing,
      importAuthPolicy: input.sourceInput.importAuthPolicy ?? null,
      importAuth: input.sourceInput.importAuth ?? null,
      storeSecretMaterial: input.storeSecretMaterial,
    });

    const draftSource = existing
      ? yield* updateSourceFromPayload({
          source: existing,
          payload: {
            name: chosenName,
            endpoint: normalizedEndpoint,
            namespace: chosenNamespace,
            status: "probing",
            enabled: true,
            binding: input.sourceInput.kind === "openapi"
              ? {
                  specUrl: normalizedSpecUrl,
                  defaultHeaders: existingBinding?.defaultHeaders ?? null,
                }
              : {
                  defaultHeaders: existingBinding?.defaultHeaders ?? null,
                },
            importAuthPolicy: importAuth.importAuthPolicy,
            importAuth: importAuth.importAuth,
            auth,
            lastError: null,
          },
          now,
        })
      : yield* createSourceFromPayload({
          workspaceId: input.sourceInput.workspaceId,
          sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
          payload: {
            name: chosenName,
            kind: input.sourceInput.kind,
            endpoint: normalizedEndpoint,
            namespace: chosenNamespace,
            status: "probing",
            enabled: true,
            binding: input.sourceInput.kind === "openapi"
              ? {
                  specUrl: normalizedSpecUrl,
                  defaultHeaders: existingBinding?.defaultHeaders ?? null,
                }
              : {
                  defaultHeaders: existingBinding?.defaultHeaders ?? null,
                },
            importAuthPolicy: importAuth.importAuthPolicy,
            importAuth: importAuth.importAuth,
            auth,
          },
          now,
        });

    const persistedDraft = yield* persistSource(input.rows, draftSource, {
      actorAccountId: input.sourceInput.actorAccountId,
    });

    if (shouldPromptForExecutorHttpRuntimeCredentialSetup({
      existing,
      explicitAuthProvided: input.sourceInput.auth !== undefined,
      auth: persistedDraft.auth,
    })) {
      const authRequiredSource = yield* updateSourceStatus(input.rows, persistedDraft, {
        actorAccountId: input.sourceInput.actorAccountId,
        status: "auth_required",
        lastError: null,
      });

      return {
        kind: "credential_required",
        source: authRequiredSource,
        credentialSlot: "runtime",
      } satisfies ExecutorSourceAddResult;
    }

    const synced = yield* Effect.either(
      syncSourceMaterialization({
        rows: input.rows,
        source: {
          ...persistedDraft,
          status: "connected",
        },
        resolveSecretMaterial: input.resolveSecretMaterial,
      }),
    );

    return yield* Either.match(synced, {
      onLeft: (error) =>
        isSourceCredentialRequiredError(error)
          ? updateSourceStatus(input.rows, persistedDraft, {
              actorAccountId: input.sourceInput.actorAccountId,
              status: "auth_required",
              lastError: null,
            }).pipe(
              Effect.map((source) =>
                ({
                  kind: "credential_required",
                  source,
                  credentialSlot: error.slot,
                } satisfies ExecutorSourceAddResult)
              ),
            )
          : updateSourceStatus(input.rows, persistedDraft, {
              actorAccountId: input.sourceInput.actorAccountId,
              status: "error",
              lastError: error.message,
            }).pipe(
              Effect.zipRight(Effect.fail(error)),
            ),
      onRight: () =>
        updateSourceStatus(input.rows, persistedDraft, {
          actorAccountId: input.sourceInput.actorAccountId,
          status: "connected",
          lastError: null,
        }).pipe(
          Effect.map((source) =>
            ({
              kind: "connected",
              source,
            } satisfies ExecutorSourceAddResult)
          ),
        ),
    });
  });

type RuntimeSourceAuthServiceShape = {
  getSourceById: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<Source, Error, never>;
  getLocalServerBaseUrl: () => string | null;
  storeSecretMaterial: (input: {
    purpose: SecretMaterialPurpose;
    value: string;
  }) => Effect.Effect<SecretRef, Error, never>;
  addExecutorSource: (
    input: ExecutorAddSourceInput,
    options?: {
      mcpDiscoveryElicitation?: McpDiscoveryElicitationContext;
      baseUrl?: string | null;
    },
  ) => Effect.Effect<ExecutorSourceAddResult, Error, never>;
  connectMcpSource: (
    input: ConnectMcpSourceInput,
  ) => Effect.Effect<McpSourceConnectResult, Error, never>;
  startSourceOAuthSession: (
    input: StartSourceOAuthSessionInput,
  ) => Effect.Effect<StartSourceOAuthSessionResult, Error, never>;
  completeSourceOAuthSession: (input: {
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteSourceOAuthSessionResult, Error, never>;
  completeSourceCredentialSetup: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<Source, Error, never>;
};

export const createRuntimeSourceAuthService = (input: {
  rows: SqlControlPlaneRows;
  liveExecutionManager: LiveExecutionManager;
  getLocalServerBaseUrl?: () => string | undefined;
}) => {
  const resolveSecretMaterial = createDefaultSecretMaterialResolver({
    rows: input.rows,
  });
  const storeSecretMaterial = createDefaultSecretMaterialStorer({
    rows: input.rows,
  });

  return {
  getLocalServerBaseUrl: () => input.getLocalServerBaseUrl?.() ?? null,

  storeSecretMaterial: ({ purpose, value }) =>
    storeSecretMaterial({
      purpose,
      value,
    }),

  getSourceById: ({ workspaceId, sourceId, actorAccountId }) =>
    loadSourceById(input.rows, {
      workspaceId,
      sourceId,
      actorAccountId,
    }),

  addExecutorSource: (sourceInput, options) =>
    hasSourceAdapterFamily(sourceInput.kind ?? "mcp", "http_api")
      ? addExecutorHttpSource({
          rows: input.rows,
          sourceInput: sourceInput as Extract<
            ExecutorAddSourceInput,
            { kind: "openapi" | "graphql" }
          >,
          storeSecretMaterial,
          resolveSecretMaterial,
        })
      : connectMcpSourceInternal({
          rows: input.rows,
          getLocalServerBaseUrl: input.getLocalServerBaseUrl,
          workspaceId: sourceInput.workspaceId,
          actorAccountId: sourceInput.actorAccountId,
          executionId: sourceInput.executionId,
          interactionId: sourceInput.interactionId,
          endpoint: sourceInput.endpoint,
          name: sourceInput.name,
          namespace: sourceInput.namespace,
          mcpDiscoveryElicitation: options?.mcpDiscoveryElicitation,
          baseUrl: options?.baseUrl,
          resolveSecretMaterial,
        }),

  connectMcpSource: (sourceInput) =>
    connectMcpSourceInternal({
      rows: input.rows,
      getLocalServerBaseUrl: input.getLocalServerBaseUrl,
      workspaceId: sourceInput.workspaceId,
      actorAccountId: sourceInput.actorAccountId,
      sourceId: sourceInput.sourceId,
      executionId: null,
      interactionId: null,
      endpoint: sourceInput.endpoint,
      name: sourceInput.name,
      namespace: sourceInput.namespace,
      enabled: sourceInput.enabled,
      transport: sourceInput.transport,
      queryParams: sourceInput.queryParams,
      headers: sourceInput.headers,
      baseUrl: sourceInput.baseUrl,
      resolveSecretMaterial,
    }),

  startSourceOAuthSession: (oauthInput) =>
    Effect.gen(function* () {
      const resolvedBaseUrl = trimOrNull(oauthInput.baseUrl) ?? input.getLocalServerBaseUrl?.() ?? null;
      if (!resolvedBaseUrl) {
        return yield* Effect.fail(
          new Error("Local executor server base URL is unavailable for OAuth setup"),
        );
      }

      const sessionId = SourceAuthSessionIdSchema.make(`src_auth_${crypto.randomUUID()}`);
      const state = createSourceOAuthSessionState({
        displayName: oauthInput.displayName,
      });
      const redirectUrl = resolveSourceOAuthCallbackUrl({
        baseUrl: resolvedBaseUrl,
      });
      const endpoint = normalizeEndpoint(oauthInput.provider.endpoint);
      const oauthStart = yield* startMcpOAuthAuthorization({
        endpoint,
        redirectUrl,
        state,
      });
      const now = Date.now();

      yield* input.rows.sourceAuthSessions.upsert({
        id: sessionId,
        workspaceId: oauthInput.workspaceId,
        sourceId: SourceIdSchema.make(`oauth_draft_${crypto.randomUUID()}`),
        actorAccountId: oauthInput.actorAccountId ?? null,
        credentialSlot: "runtime",
        executionId: null,
        interactionId: null,
        providerKind: "mcp_oauth",
        status: "pending",
        state,
        sessionDataJson: encodeMcpSourceAuthSessionData({
          kind: "mcp_oauth",
          endpoint,
          redirectUri: redirectUrl,
          scope: oauthInput.provider.kind,
          resourceMetadataUrl: oauthStart.resourceMetadataUrl,
          authorizationServerUrl: oauthStart.authorizationServerUrl,
          resourceMetadata: oauthStart.resourceMetadata,
          authorizationServerMetadata: oauthStart.authorizationServerMetadata,
          clientInformation: oauthStart.clientInformation,
          codeVerifier: oauthStart.codeVerifier,
          authorizationUrl: oauthStart.authorizationUrl,
        }),
        errorText: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        sessionId,
        authorizationUrl: oauthStart.authorizationUrl,
      } satisfies StartSourceOAuthSessionResult;
    }),

  completeSourceOAuthSession: ({
    state,
    code,
    error,
    errorDescription,
  }) =>
    Effect.gen(function* () {
      const sessionOption = yield* input.rows.sourceAuthSessions.getByState(state);
      if (Option.isNone(sessionOption)) {
        return yield* Effect.fail(new Error(`Source auth session not found for state ${state}`));
      }

      const session = sessionOption.value;
      const sessionData = decodeMcpSourceAuthSessionData(session);
      if (session.status === "completed") {
        return yield* Effect.fail(new Error(`Source auth session ${session.id} is already completed`));
      }

      if (session.status !== "pending") {
        return yield* Effect.fail(new Error(`Source auth session ${session.id} is not pending`));
      }

      if (trimOrNull(error) !== null) {
        const reason = trimOrNull(errorDescription) ?? trimOrNull(error) ?? "OAuth authorization failed";
        const failedAt = Date.now();

        yield* input.rows.sourceAuthSessions.update(
          session.id,
          createTerminalSourceAuthSessionPatch({
            sessionDataJson: session.sessionDataJson,
            status: "failed",
            now: failedAt,
            errorText: reason,
          }),
        );

        return yield* Effect.fail(new Error(reason));
      }

      const authorizationCode = trimOrNull(code);
      if (authorizationCode === null) {
        return yield* Effect.fail(new Error("Missing OAuth authorization code"));
      }

      if (sessionData.codeVerifier === null) {
        return yield* Effect.fail(new Error("OAuth session is missing the PKCE code verifier"));
      }

      if (sessionData.scope !== null && sessionData.scope !== "mcp") {
        return yield* Effect.fail(new Error(`Unsupported OAuth provider: ${sessionData.scope}`));
      }

      const exchanged = yield* exchangeMcpOAuthAuthorizationCode({
        session: {
          endpoint: sessionData.endpoint,
          redirectUrl: sessionData.redirectUri,
          codeVerifier: sessionData.codeVerifier,
          resourceMetadataUrl: sessionData.resourceMetadataUrl,
          authorizationServerUrl: sessionData.authorizationServerUrl,
          resourceMetadata: sessionData.resourceMetadata,
          authorizationServerMetadata: sessionData.authorizationServerMetadata,
          clientInformation: sessionData.clientInformation,
        },
        code: authorizationCode,
      });

      const oauthSecretName = resolveSourceOAuthSecretName({
        displayName: readSourceOAuthSessionDisplayName(session.state),
        endpoint: sessionData.endpoint,
      });
      const accessTokenRef = yield* storeSecretMaterial({
        purpose: "oauth_access_token",
        value: exchanged.tokens.access_token,
        name: oauthSecretName,
      });
      const refreshTokenRef = exchanged.tokens.refresh_token
        ? yield* storeSecretMaterial({
            purpose: "oauth_refresh_token",
            value: exchanged.tokens.refresh_token,
            name: `${oauthSecretName} Refresh`,
          })
        : null;

      const auth = {
        kind: "oauth2",
        headerName: "Authorization",
        prefix: "Bearer ",
        accessToken: accessTokenRef,
        refreshToken: refreshTokenRef,
      } satisfies Extract<Source["auth"], { kind: "oauth2" }>;

      yield* input.rows.sourceAuthSessions.update(
        session.id,
        createTerminalSourceAuthSessionPatch({
          sessionDataJson: mergeMcpSourceAuthSessionData({
            session,
            patch: {
              codeVerifier: null,
              authorizationUrl: null,
              resourceMetadataUrl: exchanged.resourceMetadataUrl,
              authorizationServerUrl: exchanged.authorizationServerUrl,
              resourceMetadata: exchanged.resourceMetadata,
              authorizationServerMetadata: exchanged.authorizationServerMetadata,
            },
          }),
          status: "completed",
          now: Date.now(),
          errorText: null,
        }),
      );

      return {
        sessionId: session.id,
        auth,
      } satisfies CompleteSourceOAuthSessionResult;
    }),

  completeSourceCredentialSetup: ({
    workspaceId,
    sourceId,
    actorAccountId,
    state,
    code,
    error,
    errorDescription,
  }) =>
    Effect.gen(function* () {
      const sessionOption = yield* input.rows.sourceAuthSessions.getByState(state);
      if (Option.isNone(sessionOption)) {
        return yield* Effect.fail(new Error(`Source auth session not found for state ${state}`));
      }

      const session = sessionOption.value;
      const sessionData = decodeMcpSourceAuthSessionData(session);
      if (session.workspaceId !== workspaceId || session.sourceId !== sourceId) {
        return yield* Effect.fail(
          new Error(
            `Source auth session ${session.id} does not match workspaceId=${workspaceId} sourceId=${sourceId}`,
          ),
        );
      }
      if (
        actorAccountId !== undefined
        && (session.actorAccountId ?? null) !== (actorAccountId ?? null)
      ) {
        return yield* Effect.fail(
          new Error(`Source auth session ${session.id} does not match the active account`),
        );
      }

      const source = yield* loadSourceById(input.rows, {
        workspaceId: session.workspaceId,
        sourceId: session.sourceId,
        actorAccountId: session.actorAccountId,
      });

      if (session.status === "completed") {
        return source;
      }

      if (session.status !== "pending") {
        return yield* Effect.fail(
          new Error(`Source auth session ${session.id} is not pending`),
        );
      }

      if (trimOrNull(error) !== null) {
        const reason = trimOrNull(errorDescription) ?? trimOrNull(error) ?? "OAuth authorization failed";
        const failedAt = Date.now();

        yield* input.rows.sourceAuthSessions.update(
          session.id,
          createTerminalSourceAuthSessionPatch({
            sessionDataJson: session.sessionDataJson,
            status: "failed",
            now: failedAt,
            errorText: reason,
          }),
        );
        const failedSource = yield* updateSourceStatus(input.rows, source, {
          actorAccountId: session.actorAccountId,
          status: "error",
          lastError: reason,
        });
        yield* syncSourceMaterialization({
          rows: input.rows,
          source: failedSource,
          resolveSecretMaterial,
        });
        yield* completeLiveInteraction({
          liveExecutionManager: input.liveExecutionManager,
          session,
          response: {
            action: "cancel",
            reason,
          },
        });

        return yield* Effect.fail(new Error(reason));
      }

      const authorizationCode = trimOrNull(code);
      if (authorizationCode === null) {
        return yield* Effect.fail(new Error("Missing OAuth authorization code"));
      }

      if (sessionData.codeVerifier === null) {
        return yield* Effect.fail(new Error("OAuth session is missing the PKCE code verifier"));
      }

      const exchanged = yield* exchangeMcpOAuthAuthorizationCode({
        session: {
          endpoint: sessionData.endpoint,
          redirectUrl: sessionData.redirectUri,
          codeVerifier: sessionData.codeVerifier,
          resourceMetadataUrl: sessionData.resourceMetadataUrl,
          authorizationServerUrl: sessionData.authorizationServerUrl,
          resourceMetadata: sessionData.resourceMetadata,
          authorizationServerMetadata: sessionData.authorizationServerMetadata,
          clientInformation: sessionData.clientInformation,
        },
        code: authorizationCode,
      });

      const oauthSecretName = resolveSourceOAuthSecretName({
        displayName: source.name,
        endpoint: source.endpoint,
      });
      const accessTokenRef = yield* storeSecretMaterial({
        purpose: "oauth_access_token",
        value: exchanged.tokens.access_token,
        name: oauthSecretName,
      });
      const refreshTokenRef = exchanged.tokens.refresh_token
        ? yield* storeSecretMaterial({
            purpose: "oauth_refresh_token",
            value: exchanged.tokens.refresh_token,
            name: `${oauthSecretName} Refresh`,
          })
        : null;

      const now = Date.now();
      const connectedSource = yield* updateSourceStatus(input.rows, source, {
        actorAccountId: session.actorAccountId,
        status: "connected",
        lastError: null,
        auth: {
          kind: "oauth2",
          headerName: "Authorization",
          prefix: "Bearer ",
          accessToken: accessTokenRef,
          refreshToken: refreshTokenRef,
        },
      });
      const indexed = yield* Effect.either(
        syncSourceMaterialization({
          rows: input.rows,
          source: connectedSource,
          resolveSecretMaterial,
        }),
      );
      yield* Either.match(indexed, {
        onLeft: (error) =>
          updateSourceStatus(input.rows, connectedSource, {
            actorAccountId: session.actorAccountId,
            status: "error",
            lastError: error.message,
          }).pipe(
            Effect.zipRight(Effect.fail(error)),
          ),
        onRight: () => Effect.succeed(undefined),
      });

      yield* input.rows.sourceAuthSessions.update(
        session.id,
        createTerminalSourceAuthSessionPatch({
          sessionDataJson: mergeMcpSourceAuthSessionData({
            session,
            patch: {
              codeVerifier: null,
              authorizationUrl: null,
              resourceMetadataUrl: exchanged.resourceMetadataUrl,
              authorizationServerUrl: exchanged.authorizationServerUrl,
              resourceMetadata: exchanged.resourceMetadata,
              authorizationServerMetadata: exchanged.authorizationServerMetadata,
            },
          }),
          status: "completed",
          now,
          errorText: null,
        }),
      );

      yield* completeLiveInteraction({
        liveExecutionManager: input.liveExecutionManager,
        session,
        response: {
          action: "accept",
        },
      });

      return connectedSource;
    }),
  } satisfies RuntimeSourceAuthServiceShape;
};

export type RuntimeSourceAuthService = RuntimeSourceAuthServiceShape;

export class RuntimeSourceAuthServiceTag extends Context.Tag(
  "#runtime/RuntimeSourceAuthServiceTag",
)<RuntimeSourceAuthServiceTag, ReturnType<typeof createRuntimeSourceAuthService>>() {}

export const RuntimeSourceAuthServiceLive = (input: {
  getLocalServerBaseUrl?: () => string | undefined;
} = {}) =>
  Layer.effect(
    RuntimeSourceAuthServiceTag,
    Effect.gen(function* () {
      const rows = yield* SqlControlPlaneRowsService;
      const liveExecutionManager = yield* LiveExecutionManagerService;

      return createRuntimeSourceAuthService({
        rows,
        liveExecutionManager,
        getLocalServerBaseUrl: input.getLocalServerBaseUrl,
      });
    }),
  );

export const ExecutorAddSourceResultSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("connected"),
    source: SourceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("credential_required"),
    source: SourceSchema,
    credentialSlot: Schema.Literal("runtime", "import"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth_required"),
    source: SourceSchema,
    sessionId: SourceAuthSessionIdSchema,
    authorizationUrl: Schema.String,
  }),
);

export type ExecutorAddSourceResult = typeof ExecutorAddSourceResultSchema.Type;
