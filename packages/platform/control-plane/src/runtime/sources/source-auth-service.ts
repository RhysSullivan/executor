import {
  createSdkMcpConnector,
  discoverMcpToolsFromConnector,
  isMcpStdioTransport,
  type McpDiscoveryElicitationContext,
} from "@executor/source-mcp";
import {
  isSourceCredentialRequiredError,
  type SourceAdapterOauth2SetupConfig,
} from "@executor/source-core";
import {
  AccountId,
  type CredentialSlot,
  McpSourceAuthSessionDataJsonSchema,
  type McpSourceAuthSessionData,
  OAuth2PkceSourceAuthSessionDataJsonSchema,
  type OAuth2PkceSourceAuthSessionData,
  type ProviderAuthGrant,
  ProviderAuthGrantIdSchema,
  ProviderOauthBatchSourceAuthSessionDataJsonSchema,
  type ProviderOauthBatchSourceAuthSessionData,
  type SecretMaterialPurpose,
  Source,
  type SourceImportAuthPolicy,
  type SourceTransport,
  SourceAuthSession,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  type SourceOauthClientInput,
  SourceSchema,
  type SecretRef,
  type StringMap,
  WorkspaceOauthClientIdSchema,
  WorkspaceSourceOauthClientIdSchema,
  WorkspaceSourceOauthClientMetadataJsonSchema,
  type WorkspaceOauthClient,
  type WorkspaceSourceOauthClientRedirectMode,
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
  sanitizePersistedElicitationResponse,
  type LiveExecutionManager,
} from "../execution/live";
import {
  getRuntimeLocalWorkspaceOption,
  provideOptionalRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "../local/runtime-context";
import {
  exchangeMcpOAuthAuthorizationCode,
  startMcpOAuthAuthorization,
} from "../auth/mcp-oauth";
import { createPersistedMcpOAuthSourceAuth } from "../auth/mcp-auth-provider";
import {
  createSourceFromPayload,
  updateSourceFromPayload,
} from "./source-definitions";
import {
  findSourceAdapterByProviderKey,
  getSourceAdapter,
  getSourceAdapterForSource,
  sourceAdapterRequiresInteractiveConnect,
  sourceAdapterUsesCredentialManagedAuth,
  sourceBindingStateFromSource,
} from "./source-adapters";
import {
  createDefaultSecretMaterialDeleter,
  type ResolveSecretMaterial,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  type StoreSecretMaterial,
} from "../local/secret-material-providers";
import {
  removeAuthLeaseAndSecrets,
  upsertOauth2AuthorizedUserLeaseFromTokenResponse,
} from "../auth/auth-leases";
import {
  listProviderGrantRefArtifacts,
  removeProviderAuthGrantSecret,
} from "../auth/provider-grant-lifecycle";
import {
  RuntimeSourceCatalogSyncService,
  type RuntimeSourceCatalogSyncShape,
} from "../catalog/source/sync";
import {
  buildOAuth2AuthorizationUrl,
  createPkceCodeVerifier,
  exchangeOAuth2AuthorizationCode,
} from "../auth/oauth2-pkce";
import { startOauthLoopbackRedirectServer } from "../auth/oauth-loopback";
import {
  type RuntimeSourceStore,
  RuntimeSourceStoreService,
} from "./source-store";
import type { WorkspaceStorageServices } from "../local/storage";
import { ControlPlaneStore, type ControlPlaneStoreShape } from "../store";
import { runtimeEffectError } from "../effect-errors";

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

const defaultSourceNameFromCommand = (command: string): string => {
  const segments = command
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments[segments.length - 1] ?? command;
};

const normalizeStringArray = (
  value: ReadonlyArray<string> | null | undefined,
): string[] | null => {
  if (!value || value.length === 0) {
    return null;
  }

  const normalized = value
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : null;
};

const slugifySourceLabel = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "mcp";
};

const createSyntheticMcpStdioEndpoint = (input: {
  endpoint?: string | null;
  name?: string | null;
  command?: string | null;
}): string => {
  const label =
    trimOrNull(input.name) ??
    trimOrNull(input.endpoint) ??
    trimOrNull(input.command) ??
    "mcp";

  return `stdio://local/${slugifySourceLabel(label)}`;
};

const normalizeMcpEndpoint = (input: {
  endpoint?: string | null;
  transport?: SourceTransport | null;
  command?: string | null;
  name?: string | null;
}): string => {
  if (isMcpStdioTransport({ transport: input.transport ?? undefined, command: input.command ?? undefined })) {
    return normalizeEndpoint(
      trimOrNull(input.endpoint) ?? createSyntheticMcpStdioEndpoint(input),
    );
  }

  const endpoint = trimOrNull(input.endpoint);
  if (endpoint === null) {
    throw new Error("Endpoint is required.");
  }

  return normalizeEndpoint(endpoint);
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

const resolveWorkspaceProviderOauthCompleteUrl = (input: {
  baseUrl: string;
  workspaceId: WorkspaceId;
}): string =>
  new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/oauth/provider/callback`,
    input.baseUrl,
  ).toString();

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint.trim());
  return url.toString();
}

const defaultGoogleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`;

const defaultGoogleDiscoverySourceName = (service: string, version: string): string => {
  const titleService = service
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");

  return `Google ${titleService || service} ${version}`;
};

const defaultGoogleDiscoveryNamespace = (service: string): string =>
  `google.${service.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")}`;

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
    if (!sourceAdapterRequiresInteractiveConnect(source.kind)) {
      return yield* runtimeEffectError("sources/source-auth-service", `Expected MCP source, received ${source.kind}`);
    }
    const bindingState = yield* sourceBindingStateFromSource(source);

    const connector = createSdkMcpConnector({
      endpoint: source.endpoint,
      transport: bindingState.transport ?? undefined,
      queryParams: bindingState.queryParams ?? undefined,
      headers: bindingState.headers ?? undefined,
      command: bindingState.command ?? undefined,
      args: bindingState.args ?? undefined,
      env: bindingState.env ?? undefined,
      cwd: bindingState.cwd ?? undefined,
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

const encodeOauth2PkceSourceAuthSessionData = (
  sessionData: OAuth2PkceSourceAuthSessionData,
): string => Schema.encodeSync(OAuth2PkceSourceAuthSessionDataJsonSchema)(sessionData);

const decodeOauth2PkceSourceAuthSessionDataJson = Schema.decodeUnknownEither(
  OAuth2PkceSourceAuthSessionDataJsonSchema,
);

const decodeOauth2PkceSourceAuthSessionData = (
  session: Pick<SourceAuthSession, "id" | "providerKind" | "sessionDataJson">,
): OAuth2PkceSourceAuthSessionData => {
  if (session.providerKind !== "oauth2_pkce") {
    throw new Error(`Unsupported source auth provider for session ${session.id}`);
  }

  const decoded = decodeOauth2PkceSourceAuthSessionDataJson(session.sessionDataJson);
  if (Either.isLeft(decoded)) {
    throw new Error(
      `Invalid source auth session data for ${session.id}: ${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
    );
  }

  return decoded.right;
};

const mergeOauth2PkceSourceAuthSessionData = (input: {
  session: Pick<SourceAuthSession, "id" | "providerKind" | "sessionDataJson">;
  patch: Partial<OAuth2PkceSourceAuthSessionData>;
}): string => {
  const existing = decodeOauth2PkceSourceAuthSessionData(input.session);
  return encodeOauth2PkceSourceAuthSessionData({
    ...existing,
    ...input.patch,
  });
};

const encodeProviderOauthBatchSourceAuthSessionData = (
  sessionData: ProviderOauthBatchSourceAuthSessionData,
): string => Schema.encodeSync(ProviderOauthBatchSourceAuthSessionDataJsonSchema)(sessionData);

const decodeProviderOauthBatchSourceAuthSessionDataJson = Schema.decodeUnknownEither(
  ProviderOauthBatchSourceAuthSessionDataJsonSchema,
);

const decodeProviderOauthBatchSourceAuthSessionData = (
  session: Pick<SourceAuthSession, "id" | "providerKind" | "sessionDataJson">,
): ProviderOauthBatchSourceAuthSessionData => {
  if (session.providerKind !== "oauth2_provider_batch") {
    throw new Error(`Unsupported source auth provider for session ${session.id}`);
  }

  const decoded = decodeProviderOauthBatchSourceAuthSessionDataJson(session.sessionDataJson);
  if (Either.isLeft(decoded)) {
    throw new Error(
      `Invalid source auth session data for ${session.id}: ${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
    );
  }

  return decoded.right;
};

const mergeProviderOauthBatchSourceAuthSessionData = (input: {
  session: Pick<SourceAuthSession, "id" | "providerKind" | "sessionDataJson">;
  patch: Partial<ProviderOauthBatchSourceAuthSessionData>;
}): string => {
  const existing = decodeProviderOauthBatchSourceAuthSessionData(input.session);
  return encodeProviderOauthBatchSourceAuthSessionData({
    ...existing,
    ...input.patch,
  });
};


const completeLiveInteraction = (input: {
  rows: ControlPlaneStoreShape;
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

    const response =
      input.response.action === "accept"
        ? { action: "accept" as const }
        : {
            action: "cancel" as const,
            ...(input.response.reason
              ? {
                  content: {
                    reason: input.response.reason,
                  },
                }
              : {}),
          };

    const resumed = yield* input.liveExecutionManager.resolveInteraction({
      executionId: input.session.executionId,
      response,
    });

    if (!resumed) {
      const pendingInteraction = yield* input.rows.executionInteractions
        .getPendingByExecutionId(input.session.executionId);

      if (Option.isSome(pendingInteraction)) {
        yield* input.rows.executionInteractions.update(pendingInteraction.value.id, {
          status: response.action === "cancel" ? "cancelled" : "resolved",
          responseJson: serializeJson(
            sanitizePersistedElicitationResponse(response),
          ),
          responsePrivateJson: serializeJson(response),
          updatedAt: Date.now(),
        });
      }
    }
  });

const serializeJson = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
};

const updateSourceStatus = Effect.fn("source.status.update")((sourceStore: RuntimeSourceStore, source: Source, input: {
  actorAccountId?: AccountId | null;
  status: Source["status"];
  lastError?: string | null;
  auth?: Source["auth"];
  importAuth?: Source["importAuth"];
}) =>
  Effect.gen(function* () {
    const latest = yield* sourceStore.loadSourceById({
      workspaceId: source.workspaceId,
      sourceId: source.id,
      actorAccountId: input.actorAccountId,
    });

    return yield* sourceStore.persistSource({
      ...latest,
      status: input.status,
      lastError: input.lastError ?? null,
      auth: input.auth ?? latest.auth,
      importAuth: input.importAuth ?? latest.importAuth,
      updatedAt: Date.now(),
    }, {
      actorAccountId: input.actorAccountId,
    });
  }).pipe(
    Effect.withSpan("source.status.update", {
      attributes: {
        "executor.source.id": source.id,
        "executor.source.status": input.status,
      },
    }),
  ));

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
      endpoint?: string | null;
      name?: string | null;
      namespace?: string | null;
      transport?: SourceTransport | null;
      queryParams?: StringMap | null;
      headers?: StringMap | null;
      command?: string | null;
      args?: ReadonlyArray<string> | null;
      env?: StringMap | null;
      cwd?: string | null;
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
    }
  | {
      kind: "google_discovery";
      workspaceId: WorkspaceId;
      actorAccountId?: AccountId | null;
      executionId: SourceAuthSession["executionId"];
      interactionId: SourceAuthSession["interactionId"];
      service: string;
      version: string;
      discoveryUrl?: string | null;
      scopes?: ReadonlyArray<string> | null;
      workspaceOauthClientId?: WorkspaceOauthClient["id"] | null;
      oauthClient?: SourceOauthClientInput | null;
      name?: string | null;
      namespace?: string | null;
      importAuthPolicy?: SourceImportAuthPolicy | null;
      importAuth?: ExecutorHttpSourceAuthInput | null;
      auth?: ExecutorHttpSourceAuthInput | null;
    };

export type ExecutorCredentialManagedSourceInput = Extract<
  ExecutorAddSourceInput,
  { kind: string }
>;

export type ExecutorHttpEndpointSourceInput = Extract<
  ExecutorCredentialManagedSourceInput,
  { endpoint: string }
>;

export type ExecutorMcpSourceInput = Exclude<
  ExecutorAddSourceInput,
  ExecutorCredentialManagedSourceInput
>;

export type ConnectMcpSourceInput = {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  sourceId?: Source["id"] | null;
  endpoint?: string | null;
  name?: string | null;
  namespace?: string | null;
  enabled?: boolean;
  transport?: SourceTransport | null;
  queryParams?: StringMap | null;
  headers?: StringMap | null;
  command?: string | null;
  args?: ReadonlyArray<string> | null;
  env?: StringMap | null;
  cwd?: string | null;
  baseUrl?: string | null;
};

export type ConnectGoogleDiscoveryBatchInput = {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  executionId: SourceAuthSession["executionId"];
  interactionId: SourceAuthSession["interactionId"];
  workspaceOauthClientId: WorkspaceOauthClient["id"];
  sources: ReadonlyArray<{
    service: string;
    version: string;
    discoveryUrl?: string | null;
    scopes?: ReadonlyArray<string> | null;
    name?: string | null;
    namespace?: string | null;
  }>;
  baseUrl?: string | null;
};

export type ConnectGoogleDiscoveryBatchResult = {
  results: ReadonlyArray<{
    source: Source;
    status: "connected" | "pending_oauth";
  }>;
  providerOauthSession: {
    sessionId: SourceAuthSession["id"];
    authorizationUrl: string;
    sourceIds: ReadonlyArray<Source["id"]>;
  } | null;
};

export type CreateWorkspaceOauthClientInput = {
  workspaceId: WorkspaceId;
  providerKey: string;
  label?: string | null;
  oauthClient: SourceOauthClientInput;
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

const isExecutorCredentialManagedSourceInput = (
  input: ExecutorAddSourceInput,
): input is ExecutorCredentialManagedSourceInput =>
  typeof input.kind === "string";

const isExecutorGoogleDiscoverySourceInput = (
  input: ExecutorAddSourceInput,
): input is Extract<ExecutorCredentialManagedSourceInput, { kind: "google_discovery" }> =>
  isExecutorCredentialManagedSourceInput(input) && input.kind === "google_discovery";

const isExecutorHttpEndpointSourceInput = (
  input: ExecutorAddSourceInput,
): input is ExecutorHttpEndpointSourceInput =>
  isExecutorCredentialManagedSourceInput(input)
  && "endpoint" in input
  && sourceAdapterUsesCredentialManagedAuth(input.kind);

const isExecutorMcpSourceInput = (
  input: ExecutorAddSourceInput,
): input is ExecutorMcpSourceInput =>
  input.kind === undefined || sourceAdapterRequiresInteractiveConnect(input.kind);

export type StartSourceOAuthSessionResult = {
  sessionId: SourceAuthSession["id"];
  authorizationUrl: string;
};

export type CompleteSourceOAuthSessionResult = {
  sessionId: SourceAuthSession["id"];
  auth: Extract<Source["auth"], { kind: "oauth2" }>;
};

export type CompleteSourceCredentialSetupResult = {
  sessionId: SourceAuthSession["id"];
  source: Source;
};

export type CompleteProviderOauthCallbackResult = {
  sessionId: SourceAuthSession["id"];
  sources: ReadonlyArray<Source>;
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

    if (input.auth === undefined && existing && sourceAdapterUsesCredentialManagedAuth(existing.kind)) {
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
        && sourceAdapterUsesCredentialManagedAuth(existing.kind)
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
        return yield* runtimeEffectError("sources/source-auth-service", "Bearer auth requires token or tokenRef");
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
      && sourceAdapterUsesCredentialManagedAuth(existing.kind)
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
      return yield* runtimeEffectError("sources/source-auth-service", "OAuth2 auth requires accessToken or accessTokenRef");
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
  sourceKind: Source["kind"];
  existing?: Source;
  importAuthPolicy?: SourceImportAuthPolicy | null;
  importAuth?: ExecutorHttpSourceAuthInput | null;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<{
  importAuthPolicy: SourceImportAuthPolicy;
  importAuth: Source["importAuth"];
}, Error, never> =>
  Effect.gen(function* () {
    const adapterDefault = sourceAdapterUsesCredentialManagedAuth(input.sourceKind)
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

type ResolvedSourceOauthClient = {
  providerKey: string;
  clientId: string;
  clientSecret: SecretRef | null;
  redirectMode: WorkspaceSourceOauthClientRedirectMode;
};

type ResolvedWorkspaceOauthClient = ResolvedSourceOauthClient & {
  id: WorkspaceOauthClient["id"];
  label: string | null;
};

type RuntimeProviderAuthTarget = {
  source: Source;
  requiredScopes: ReadonlyArray<string>;
  setupConfig: SourceAdapterOauth2SetupConfig;
};

type RuntimeProviderAuthResult =
  | {
      kind: "connected";
      sources: ReadonlyArray<Source>;
    }
  | {
      kind: "oauth_required";
      sources: ReadonlyArray<Source>;
      sessionId: SourceAuthSession["id"];
      authorizationUrl: string;
    };

const decodeWorkspaceSourceOauthClientMetadataOption = Schema.decodeUnknownOption(
  WorkspaceSourceOauthClientMetadataJsonSchema,
);

const encodeWorkspaceSourceOauthClientMetadataJson = Schema.encodeSync(
  WorkspaceSourceOauthClientMetadataJsonSchema,
);

const sourceOauthClientRedirectMode = (client: {
  clientMetadataJson: string | null;
}): WorkspaceSourceOauthClientRedirectMode => {
  if (client.clientMetadataJson === null) {
    return "app_callback";
  }

  const decoded = decodeWorkspaceSourceOauthClientMetadataOption(
    client.clientMetadataJson,
  );
  if (Option.isNone(decoded)) {
    return "app_callback";
  }

  return decoded.value.redirectMode ?? "app_callback";
};

const sourceOauthClientSecretRef = (client: {
  clientSecretProviderId: string | null;
  clientSecretHandle: string | null;
}): SecretRef | null =>
  client.clientSecretProviderId && client.clientSecretHandle
    ? {
        providerId: client.clientSecretProviderId,
        handle: client.clientSecretHandle,
      }
    : null;

const upsertSourceOauthClient = (input: {
  rows: ControlPlaneStoreShape;
  source: Source;
  oauthClient: SourceOauthClientInput;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<ResolvedSourceOauthClient, Error, never> =>
  Effect.gen(function* () {
    const adapter = getSourceAdapterForSource(input.source);
    const setupConfig = adapter.getOauth2SetupConfig
      ? yield* adapter.getOauth2SetupConfig({
          source: input.source,
          slot: "runtime",
        })
      : null;
    if (setupConfig === null) {
      return yield* runtimeEffectError("sources/source-auth-service", `Source ${input.source.id} does not support OAuth client configuration`);
    }

    const existing = yield* input.rows.sourceOauthClients.getByWorkspaceSourceAndProvider({
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      providerKey: setupConfig.providerKey,
    });
    const normalizedOauthClient = adapter.normalizeOauthClientInput
      ? yield* adapter.normalizeOauthClientInput(input.oauthClient)
      : input.oauthClient;
    const previousClientSecretRef = Option.isSome(existing)
      ? sourceOauthClientSecretRef(existing.value)
      : null;
    const clientSecretRef = normalizedOauthClient.clientSecret
      ? yield* input.storeSecretMaterial({
          purpose: "oauth_client_info",
          value: normalizedOauthClient.clientSecret,
        })
      : null;
    const now = Date.now();
    const clientId = Option.isSome(existing)
      ? existing.value.id
      : WorkspaceSourceOauthClientIdSchema.make(
          `src_oauth_client_${crypto.randomUUID()}`,
        );
    yield* input.rows.sourceOauthClients.upsert({
      id: clientId,
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      providerKey: setupConfig.providerKey,
      clientId: normalizedOauthClient.clientId,
      clientSecretProviderId: clientSecretRef?.providerId ?? null,
      clientSecretHandle: clientSecretRef?.handle ?? null,
      clientMetadataJson: encodeWorkspaceSourceOauthClientMetadataJson({
        redirectMode: normalizedOauthClient.redirectMode ?? "app_callback",
      }),
      createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
      updatedAt: now,
    });
    if (
      previousClientSecretRef
      && (
        clientSecretRef === null
        || previousClientSecretRef.providerId !== clientSecretRef.providerId
        || previousClientSecretRef.handle !== clientSecretRef.handle
      )
    ) {
      const deleteSecretMaterial = createDefaultSecretMaterialDeleter({
        rows: input.rows,
      });
      yield* deleteSecretMaterial(previousClientSecretRef).pipe(
        Effect.either,
        Effect.ignore,
      );
    }

    return {
      providerKey: setupConfig.providerKey,
      clientId: normalizedOauthClient.clientId,
      clientSecret: clientSecretRef,
      redirectMode: normalizedOauthClient.redirectMode ?? "app_callback",
    };
  });

const resolveExistingSourceOauthClient = (input: {
  rows: ControlPlaneStoreShape;
  source: Source;
}): Effect.Effect<ResolvedSourceOauthClient | null, Error, never> =>
  Effect.gen(function* () {
    const adapter = getSourceAdapterForSource(input.source);
    const setupConfig = adapter.getOauth2SetupConfig
      ? yield* adapter.getOauth2SetupConfig({
          source: input.source,
          slot: "runtime",
        })
      : null;
    if (setupConfig === null) {
      return null;
    }

    const existing = yield* input.rows.sourceOauthClients.getByWorkspaceSourceAndProvider({
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      providerKey: setupConfig.providerKey,
    });
    if (Option.isNone(existing)) {
      return null;
    }

    return {
      providerKey: existing.value.providerKey,
      clientId: existing.value.clientId,
      clientSecret: sourceOauthClientSecretRef(existing.value),
      redirectMode: sourceOauthClientRedirectMode(existing.value),
    };
  });

const createWorkspaceOauthClient = (input: {
  rows: ControlPlaneStoreShape;
  workspaceId: WorkspaceId;
  providerKey: string;
  oauthClient: SourceOauthClientInput;
  label?: string | null;
  normalizeOauthClient?: (
    input: SourceOauthClientInput,
  ) => Effect.Effect<SourceOauthClientInput, Error, never>;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<ResolvedWorkspaceOauthClient, Error, never> =>
  Effect.gen(function* () {
    const normalizedOauthClient = input.normalizeOauthClient
      ? yield* input.normalizeOauthClient(input.oauthClient)
      : input.oauthClient;
    const clientSecretRef = normalizedOauthClient.clientSecret
      ? yield* input.storeSecretMaterial({
          purpose: "oauth_client_info",
          value: normalizedOauthClient.clientSecret,
        })
      : null;
    const now = Date.now();
    const id = WorkspaceOauthClientIdSchema.make(
      `ws_oauth_client_${crypto.randomUUID()}`,
    );

    yield* input.rows.workspaceOauthClients.upsert({
      id,
      workspaceId: input.workspaceId,
      providerKey: input.providerKey,
      label: trimOrNull(input.label) ?? null,
      clientId: normalizedOauthClient.clientId,
      clientSecretProviderId: clientSecretRef?.providerId ?? null,
      clientSecretHandle: clientSecretRef?.handle ?? null,
      clientMetadataJson: encodeWorkspaceSourceOauthClientMetadataJson({
        redirectMode: normalizedOauthClient.redirectMode ?? "app_callback",
      }),
      createdAt: now,
      updatedAt: now,
    });

    return {
      id,
      providerKey: input.providerKey,
      label: trimOrNull(input.label) ?? null,
      clientId: normalizedOauthClient.clientId,
      clientSecret: clientSecretRef,
      redirectMode: normalizedOauthClient.redirectMode ?? "app_callback",
    };
  });

const resolveWorkspaceOauthClientById = (input: {
  rows: ControlPlaneStoreShape;
  workspaceId: WorkspaceId;
  oauthClientId: WorkspaceOauthClient["id"];
  providerKey: string;
}): Effect.Effect<ResolvedWorkspaceOauthClient | null, Error, never> =>
  Effect.gen(function* () {
    const existing = yield* input.rows.workspaceOauthClients.getById(input.oauthClientId);
    if (Option.isNone(existing)) {
      return null;
    }

    if (
      existing.value.workspaceId !== input.workspaceId
      || existing.value.providerKey !== input.providerKey
    ) {
      return yield* runtimeEffectError("sources/source-auth-service", `Workspace OAuth client ${input.oauthClientId} is not valid for ${input.providerKey}`);
    }

    return {
      id: existing.value.id,
      providerKey: existing.value.providerKey,
      label: existing.value.label,
      clientId: existing.value.clientId,
      clientSecret: sourceOauthClientSecretRef(existing.value),
      redirectMode: sourceOauthClientRedirectMode(existing.value),
    };
  });

const providerGrantCoversScopes = (
  grantedScopes: ReadonlyArray<string>,
  requiredScopes: ReadonlyArray<string>,
): boolean => {
  const granted = new Set(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope));
};

const normalizeScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))];

const authorizationParamsMatch = (
  left: SourceAdapterOauth2SetupConfig["authorizationParams"],
  right: SourceAdapterOauth2SetupConfig["authorizationParams"],
): boolean => {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );

  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => {
      const otherEntry = rightEntries[index];
      return otherEntry !== undefined
        && otherEntry[0] === key
        && otherEntry[1] === value;
    });
};

const providerOauthSetupConfigMatches = (
  left: SourceAdapterOauth2SetupConfig,
  right: SourceAdapterOauth2SetupConfig,
): boolean =>
  left.providerKey === right.providerKey
  && left.authorizationEndpoint === right.authorizationEndpoint
  && left.tokenEndpoint === right.tokenEndpoint
  && left.headerName === right.headerName
  && left.prefix === right.prefix
  && left.clientAuthentication === right.clientAuthentication
  && authorizationParamsMatch(left.authorizationParams, right.authorizationParams);

const resolveRuntimeProviderAuthTarget = (
  source: Source,
): Effect.Effect<RuntimeProviderAuthTarget | null, Error, never> =>
  Effect.gen(function* () {
    const adapter = getSourceAdapterForSource(source);
    const setupConfig = adapter.getOauth2SetupConfig
      ? yield* adapter.getOauth2SetupConfig({
          source,
          slot: "runtime",
        })
      : null;
    if (setupConfig === null) {
      return null;
    }

    return {
      source,
      requiredScopes: normalizeScopes(setupConfig.scopes),
      setupConfig,
    } satisfies RuntimeProviderAuthTarget;
  });

const mergeRuntimeProviderAuthSetupConfig = (
  targets: ReadonlyArray<RuntimeProviderAuthTarget>,
): Effect.Effect<SourceAdapterOauth2SetupConfig, Error, never> =>
  Effect.gen(function* () {
    if (targets.length === 0) {
      return yield* runtimeEffectError("sources/source-auth-service", "Provider auth setup requires at least one target source");
    }

    const baseSetupConfig = targets[0]!.setupConfig;
    for (const target of targets.slice(1)) {
      if (!providerOauthSetupConfigMatches(baseSetupConfig, target.setupConfig)) {
        return yield* runtimeEffectError(
          "sources/source-auth-service",
          `Provider auth setup for ${baseSetupConfig.providerKey} requires compatible source OAuth configuration`,
        );
      }
    }

    return {
      ...baseSetupConfig,
      scopes: normalizeScopes(targets.flatMap((target) => [...target.requiredScopes])),
    };
  });

const findReusableProviderGrant = (input: {
  rows: ControlPlaneStoreShape;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  providerKey: string;
  oauthClientId: WorkspaceOauthClient["id"];
  requiredScopes: ReadonlyArray<string>;
}): Effect.Effect<import("effect/Option").Option<import("#schema").ProviderAuthGrant>, Error, never> =>
  Effect.map(
    input.rows.providerAuthGrants.listByWorkspaceActorAndProvider({
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId ?? null,
      providerKey: input.providerKey,
    }),
    (grants) =>
      Option.fromNullable(
        grants.find(
          (grant) =>
            grant.oauthClientId === input.oauthClientId
            && providerGrantCoversScopes(grant.grantedScopes, input.requiredScopes),
        ),
      ),
  );

const upsertProviderAuthGrant = (input: {
  rows: ControlPlaneStoreShape;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  providerKey: string;
  oauthClientId: WorkspaceOauthClient["id"];
  tokenEndpoint: string;
  clientAuthentication: "none" | "client_secret_post";
  headerName: string;
  prefix: string;
  grantedScopes: ReadonlyArray<string>;
  refreshToken: string | null;
  storeSecretMaterial: StoreSecretMaterial;
  existingGrant?: import("#schema").ProviderAuthGrant | null;
}): Effect.Effect<import("#schema").ProviderAuthGrant, Error, never> =>
  Effect.gen(function* () {
    const existingGrant = input.existingGrant ?? null;
    let refreshTokenRef = existingGrant?.refreshToken ?? null;
    if (input.refreshToken !== null) {
      refreshTokenRef = yield* input.storeSecretMaterial({
        purpose: "oauth_refresh_token",
        value: input.refreshToken,
        name: `${input.providerKey} Refresh`,
      });
    }

    if (refreshTokenRef === null) {
      return yield* runtimeEffectError("sources/source-auth-service", `Provider auth grant for ${input.providerKey} is missing a refresh token`);
    }

    const now = Date.now();
    const nextGrant = {
      id: existingGrant?.id ?? ProviderAuthGrantIdSchema.make(`provider_grant_${crypto.randomUUID()}`),
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId ?? null,
      providerKey: input.providerKey,
      oauthClientId: input.oauthClientId,
      tokenEndpoint: input.tokenEndpoint,
      clientAuthentication: input.clientAuthentication,
      headerName: input.headerName,
      prefix: input.prefix,
      refreshToken: refreshTokenRef,
      grantedScopes: [...normalizeScopes([
        ...(existingGrant?.grantedScopes ?? []),
        ...input.grantedScopes,
      ])],
      lastRefreshedAt: existingGrant?.lastRefreshedAt ?? null,
      orphanedAt: null,
      createdAt: existingGrant?.createdAt ?? now,
      updatedAt: now,
    } satisfies import("#schema").ProviderAuthGrant;

    yield* input.rows.providerAuthGrants.upsert(nextGrant);

    if (
      existingGrant?.refreshToken
      && (
        existingGrant.refreshToken.providerId !== refreshTokenRef.providerId
        || existingGrant.refreshToken.handle !== refreshTokenRef.handle
      )
    ) {
      const deleteSecretMaterial = createDefaultSecretMaterialDeleter({
        rows: input.rows,
      });
      yield* deleteSecretMaterial(existingGrant.refreshToken).pipe(
        Effect.either,
        Effect.ignore,
      );
    }

    return nextGrant;
  });

const startOauth2PkceSourceCredentialSetup = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  source: Source;
  actorAccountId?: AccountId | null;
  executionId?: SourceAuthSession["executionId"];
  interactionId?: SourceAuthSession["interactionId"];
  baseUrl: string;
  redirectModeOverride?: WorkspaceSourceOauthClientRedirectMode;
  storeSecretMaterial: StoreSecretMaterial;
}): Effect.Effect<
  Extract<ExecutorSourceAddResult, { kind: "oauth_required" }> | null,
  Error,
  WorkspaceStorageServices
> =>
  Effect.gen(function* () {
    const adapter = getSourceAdapterForSource(input.source);
    const setupConfig = adapter.getOauth2SetupConfig
      ? yield* adapter.getOauth2SetupConfig({
          source: input.source,
          slot: "runtime",
        })
      : null;
    if (setupConfig === null) {
      return null;
    }

    const oauthClient = yield* resolveExistingSourceOauthClient({
      rows: input.rows,
      source: input.source,
    });
    if (oauthClient === null) {
      return null;
    }

    const sessionId = SourceAuthSessionIdSchema.make(`src_auth_${crypto.randomUUID()}`);
    const state = crypto.randomUUID();
    const completionUrl = resolveSourceCredentialOauthCompleteUrl({
      baseUrl: input.baseUrl,
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
    });
    const redirectMode = input.redirectModeOverride ?? oauthClient.redirectMode;
    const redirectServer = redirectMode === "loopback"
      ? yield* startOauthLoopbackRedirectServer({
          completionUrl,
        })
      : null;
    const redirectUri = redirectServer?.redirectUri ?? completionUrl;
    const codeVerifier = createPkceCodeVerifier();
    return yield* Effect.gen(function* () {
      const authorizationUrl = buildOAuth2AuthorizationUrl({
        authorizationEndpoint: setupConfig.authorizationEndpoint,
        clientId: oauthClient.clientId,
        redirectUri,
        scopes: [...setupConfig.scopes],
        state,
        codeVerifier,
        extraParams: setupConfig.authorizationParams,
      });
      const now = Date.now();

      yield* input.rows.sourceAuthSessions.upsert({
        id: sessionId,
        workspaceId: input.source.workspaceId,
        sourceId: input.source.id,
        actorAccountId: input.actorAccountId ?? null,
        credentialSlot: "runtime",
        executionId: input.executionId ?? null,
        interactionId: input.interactionId ?? null,
        providerKind: "oauth2_pkce",
        status: "pending",
        state,
        sessionDataJson: encodeOauth2PkceSourceAuthSessionData({
          kind: "oauth2_pkce",
          providerKey: setupConfig.providerKey,
          authorizationEndpoint: setupConfig.authorizationEndpoint,
          tokenEndpoint: setupConfig.tokenEndpoint,
          redirectUri,
          clientId: oauthClient.clientId,
          clientAuthentication: setupConfig.clientAuthentication,
          clientSecret: oauthClient.clientSecret,
          scopes: [...setupConfig.scopes],
          headerName: setupConfig.headerName,
          prefix: setupConfig.prefix,
          authorizationParams: {
            ...setupConfig.authorizationParams,
          },
          codeVerifier,
          authorizationUrl,
        }),
        errorText: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const authRequiredSource = yield* updateSourceStatus(input.sourceStore, input.source, {
        actorAccountId: input.actorAccountId,
        status: "auth_required",
        lastError: null,
      });

      return {
        kind: "oauth_required",
        source: authRequiredSource,
        sessionId,
        authorizationUrl,
      } satisfies Extract<ExecutorSourceAddResult, { kind: "oauth_required" }>;
    }).pipe(
      Effect.onError(() =>
        redirectServer
          ? redirectServer.close.pipe(Effect.orDie)
          : Effect.void
      ),
    );
  });

const startProviderOauthBatchCredentialSetup = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  executionId?: SourceAuthSession["executionId"];
  interactionId?: SourceAuthSession["interactionId"];
  baseUrl: string;
  redirectModeOverride?: WorkspaceSourceOauthClientRedirectMode;
  workspaceOauthClient: ResolvedWorkspaceOauthClient;
  setupConfig: SourceAdapterOauth2SetupConfig;
  targetSources: ReadonlyArray<{
    source: Source;
    requiredScopes: ReadonlyArray<string>;
  }>;
}): Effect.Effect<{
  sessionId: SourceAuthSession["id"];
  authorizationUrl: string;
  source: Source;
}, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    if (input.targetSources.length === 0) {
      return yield* runtimeEffectError("sources/source-auth-service", "Provider OAuth setup requires at least one target source");
    }

    const sessionId = SourceAuthSessionIdSchema.make(`src_auth_${crypto.randomUUID()}`);
    const state = crypto.randomUUID();
    const completionUrl = resolveWorkspaceProviderOauthCompleteUrl({
      baseUrl: input.baseUrl,
      workspaceId: input.workspaceId,
    });
    const redirectMode = input.redirectModeOverride ?? input.workspaceOauthClient.redirectMode;
    const redirectServer = redirectMode === "loopback"
      ? yield* startOauthLoopbackRedirectServer({
          completionUrl,
        })
      : null;
    const redirectUri = redirectServer?.redirectUri ?? completionUrl;
    const codeVerifier = createPkceCodeVerifier();

    return yield* Effect.gen(function* () {
      const authorizationUrl = buildOAuth2AuthorizationUrl({
        authorizationEndpoint: input.setupConfig.authorizationEndpoint,
        clientId: input.workspaceOauthClient.clientId,
        redirectUri,
        scopes: [...normalizeScopes(input.setupConfig.scopes)],
        state,
        codeVerifier,
        extraParams: input.setupConfig.authorizationParams,
      });
      const now = Date.now();

      yield* input.rows.sourceAuthSessions.upsert({
        id: sessionId,
        workspaceId: input.workspaceId,
        sourceId: SourceIdSchema.make(`oauth_provider_${crypto.randomUUID()}`),
        actorAccountId: input.actorAccountId ?? null,
        credentialSlot: "runtime",
        executionId: input.executionId ?? null,
        interactionId: input.interactionId ?? null,
        providerKind: "oauth2_provider_batch",
        status: "pending",
        state,
        sessionDataJson: encodeProviderOauthBatchSourceAuthSessionData({
          kind: "provider_oauth_batch",
          providerKey: input.setupConfig.providerKey,
          authorizationEndpoint: input.setupConfig.authorizationEndpoint,
          tokenEndpoint: input.setupConfig.tokenEndpoint,
          redirectUri,
          oauthClientId: input.workspaceOauthClient.id,
          clientAuthentication: input.setupConfig.clientAuthentication,
          scopes: [...normalizeScopes(input.setupConfig.scopes)],
          headerName: input.setupConfig.headerName,
          prefix: input.setupConfig.prefix,
          authorizationParams: {
            ...input.setupConfig.authorizationParams,
          },
          targetSources: input.targetSources.map((target) => ({
            sourceId: target.source.id,
            requiredScopes: [...normalizeScopes(target.requiredScopes)],
          })),
          codeVerifier,
          authorizationUrl,
        }),
        errorText: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const primarySource = yield* updateSourceStatus(
        input.sourceStore,
        input.targetSources[0]!.source,
        {
          actorAccountId: input.actorAccountId,
          status: "auth_required",
          lastError: null,
        },
      );

      yield* Effect.forEach(
        input.targetSources.slice(1),
        (target) =>
          updateSourceStatus(input.sourceStore, target.source, {
            actorAccountId: input.actorAccountId,
            status: "auth_required",
            lastError: null,
          }).pipe(Effect.asVoid),
        { discard: true },
      );

      return {
        sessionId,
        authorizationUrl,
        source: primarySource,
      };
    }).pipe(
      Effect.onError(() =>
        redirectServer
          ? redirectServer.close.pipe(Effect.orDie)
          : Effect.void
      ),
    );
  });

const connectSourcesWithProviderRuntimeAuth = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  executionId?: SourceAuthSession["executionId"];
  interactionId?: SourceAuthSession["interactionId"];
  baseUrl?: string | null;
  getLocalServerBaseUrl?: () => string | undefined;
  workspaceOauthClient: ResolvedWorkspaceOauthClient;
  targets: ReadonlyArray<RuntimeProviderAuthTarget>;
}): Effect.Effect<RuntimeProviderAuthResult, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const setupConfig = yield* mergeRuntimeProviderAuthSetupConfig(input.targets);
    const reusableGrant = yield* findReusableProviderGrant({
      rows: input.rows,
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
      providerKey: setupConfig.providerKey,
      oauthClientId: input.workspaceOauthClient.id,
      requiredScopes: setupConfig.scopes,
    });

    if (Option.isSome(reusableGrant)) {
      const connectedSources = yield* attachProviderGrantToSources({
        sourceStore: input.sourceStore,
        sourceCatalogSync: input.sourceCatalogSync,
        actorAccountId: input.actorAccountId,
        grantId: reusableGrant.value.id,
        providerKey: reusableGrant.value.providerKey,
        headerName: reusableGrant.value.headerName,
        prefix: reusableGrant.value.prefix,
        targets: input.targets.map((target) => ({
          source: target.source,
          requiredScopes: target.requiredScopes,
        })),
      });

      return {
        kind: "connected",
        sources: connectedSources,
      } satisfies RuntimeProviderAuthResult;
    }

    const requestBaseUrl = trimOrNull(input.baseUrl);
    const baseUrl = requestBaseUrl ?? input.getLocalServerBaseUrl?.() ?? null;
    if (baseUrl === null) {
      return yield* runtimeEffectError(
        "sources/source-auth-service",
        `Local executor server base URL is unavailable for ${setupConfig.providerKey} OAuth setup`,
      );
    }

    const oauthRequired = yield* startProviderOauthBatchCredentialSetup({
      rows: input.rows,
      sourceStore: input.sourceStore,
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
      executionId: input.executionId,
      interactionId: input.interactionId,
      baseUrl,
      redirectModeOverride: requestBaseUrl ? "app_callback" : undefined,
      workspaceOauthClient: input.workspaceOauthClient,
      setupConfig,
      targetSources: input.targets.map((target) => ({
        source: target.source,
        requiredScopes: target.requiredScopes,
      })),
    });

    const pendingSources = yield* Effect.forEach(
      input.targets,
      (target) =>
        input.sourceStore.loadSourceById({
          workspaceId: target.source.workspaceId,
          sourceId: target.source.id,
          actorAccountId: input.actorAccountId,
        }),
      { discard: false },
    );

    return {
      kind: "oauth_required",
      sources: pendingSources,
      sessionId: oauthRequired.sessionId,
      authorizationUrl: oauthRequired.authorizationUrl,
    } satisfies RuntimeProviderAuthResult;
  });

const attachProviderGrantToSources = (input: {
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  actorAccountId?: AccountId | null;
  grantId: ProviderAuthGrant["id"];
  providerKey: string;
  headerName: string;
  prefix: string;
  targets: ReadonlyArray<{
    source: Source;
    requiredScopes: ReadonlyArray<string>;
  }>;
}): Effect.Effect<ReadonlyArray<Source>, Error, WorkspaceStorageServices> =>
  Effect.forEach(
    input.targets,
    (target) =>
      Effect.gen(function* () {
        const connectedSource = yield* updateSourceStatus(input.sourceStore, target.source, {
          actorAccountId: input.actorAccountId,
          status: "connected",
          lastError: null,
          auth: {
            kind: "provider_grant_ref",
            grantId: input.grantId,
            providerKey: input.providerKey,
            requiredScopes: [...normalizeScopes(target.requiredScopes)],
            headerName: input.headerName,
            prefix: input.prefix,
          },
        });

        yield* input.sourceCatalogSync.sync({
          source: connectedSource,
          actorAccountId: input.actorAccountId,
        });

        return connectedSource;
      }),
    { discard: false },
  );

const removeProviderAuthGrantInternal = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  workspaceId: WorkspaceId;
  grantId: ProviderAuthGrant["id"];
}): Effect.Effect<boolean, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const grantOption = yield* input.rows.providerAuthGrants.getById(input.grantId);
    if (Option.isNone(grantOption) || grantOption.value.workspaceId !== input.workspaceId) {
      return false;
    }

    const references = yield* listProviderGrantRefArtifacts(input.rows, {
      workspaceId: input.workspaceId,
      grantId: input.grantId,
    });

    yield* Effect.forEach(
      references,
      (artifact) =>
        Effect.gen(function* () {
          const latestSource = yield* input.sourceStore.loadSourceById({
            workspaceId: artifact.workspaceId,
            sourceId: artifact.sourceId,
            actorAccountId: artifact.actorAccountId,
          }).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );

          if (latestSource === null) {
            yield* removeAuthLeaseAndSecrets(input.rows, {
              authArtifactId: artifact.id,
            });
            yield* input.rows.authArtifacts.removeByWorkspaceSourceAndActor({
              workspaceId: artifact.workspaceId,
              sourceId: artifact.sourceId,
              actorAccountId: artifact.actorAccountId,
              slot: artifact.slot,
            });
            return;
          }

          yield* input.sourceStore.persistSource({
            ...latestSource,
            status: "auth_required",
            lastError: null,
            auth: artifact.slot === "runtime" ? { kind: "none" } : latestSource.auth,
            importAuth: artifact.slot === "import" ? { kind: "none" } : latestSource.importAuth,
            updatedAt: Date.now(),
          }, {
            actorAccountId: artifact.actorAccountId,
          }).pipe(Effect.asVoid);
        }),
      { discard: true },
    );

    yield* removeProviderAuthGrantSecret(input.rows, {
      grant: grantOption.value,
    });
    yield* input.rows.providerAuthGrants.removeById(input.grantId);
    return true;
  });

const connectMcpSourceInternal = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  getLocalServerBaseUrl?: () => string | undefined;
  baseUrl?: string | null;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  sourceId?: Source["id"] | null;
  executionId?: SourceAuthSession["executionId"];
  interactionId?: SourceAuthSession["interactionId"];
  endpoint?: string | null;
  name?: string | null;
  namespace?: string | null;
  enabled?: boolean;
  transport?: SourceTransport | null;
  queryParams?: StringMap | null;
  headers?: StringMap | null;
  command?: string | null;
  args?: ReadonlyArray<string> | null;
  env?: StringMap | null;
  cwd?: string | null;
  mcpDiscoveryElicitation?: McpDiscoveryElicitationContext;
  resolveSecretMaterial: ResolveSecretMaterial;
}): Effect.Effect<McpSourceConnectResult, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const lookupEndpoint = input.sourceId
      ? null
      : normalizeMcpEndpoint({
          endpoint: input.endpoint ?? null,
          transport: input.transport ?? null,
          command: input.command ?? null,
          name: input.name ?? null,
        });
    const existing = yield* (
      input.sourceId
        ? input.sourceStore.loadSourceById({
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            actorAccountId: input.actorAccountId,
          }).pipe(
            Effect.flatMap((source) =>
              sourceAdapterRequiresInteractiveConnect(source.kind)
                ? Effect.succeed(source)
                : Effect.fail(runtimeEffectError("sources/source-auth-service", `Expected MCP source, received ${source.kind}`)),
            ),
          )
        : input.sourceStore.loadSourcesInWorkspace(input.workspaceId, {
            actorAccountId: input.actorAccountId,
          }).pipe(
            Effect.map((sources) =>
              sources.find(
                (source) =>
                  sourceAdapterRequiresInteractiveConnect(source.kind)
                  && lookupEndpoint !== null
                  && normalizeEndpoint(source.endpoint) === lookupEndpoint,
              ),
            ),
          )
    );

    const existingBinding = existing
      ? yield* sourceBindingStateFromSource(existing)
      : null;
    const chosenCommand =
      input.command !== undefined ? trimOrNull(input.command) : (existingBinding?.command ?? null);
    const chosenTransport = input.transport !== undefined && input.transport !== null
      ? input.transport
      : isMcpStdioTransport({
        transport: existingBinding?.transport ?? undefined,
        command: chosenCommand ?? undefined,
      })
      ? "stdio"
      : (existingBinding?.transport ?? "auto");
    if (chosenTransport === "stdio" && chosenCommand === null) {
      return yield* runtimeEffectError("sources/source-auth-service", "MCP stdio transport requires a command");
    }
    const normalizedEndpoint = normalizeMcpEndpoint({
      endpoint: input.endpoint ?? existing?.endpoint ?? null,
      transport: chosenTransport,
      command: chosenCommand,
      name: input.name ?? existing?.name ?? null,
    });
    const chosenName =
      trimOrNull(input.name)
      ?? existing?.name
      ?? (chosenTransport === "stdio" && chosenCommand !== null
        ? defaultSourceNameFromCommand(chosenCommand)
        : defaultSourceNameFromEndpoint(normalizedEndpoint));
    const chosenNamespace =
      trimOrNull(input.namespace)
      ?? existing?.namespace
      ?? defaultNamespaceFromName(chosenName);
    const chosenEnabled = input.enabled ?? existing?.enabled ?? true;
    const chosenQueryParams =
      chosenTransport === "stdio"
        ? null
        : input.queryParams !== undefined
        ? input.queryParams
        : (existingBinding?.queryParams ?? null);
    const chosenHeaders =
      chosenTransport === "stdio"
        ? null
        : input.headers !== undefined
        ? input.headers
        : (existingBinding?.headers ?? null);
    const chosenArgs =
      input.args !== undefined ? normalizeStringArray(input.args) : (existingBinding?.args ?? null);
    const chosenEnv =
      input.env !== undefined ? input.env : (existingBinding?.env ?? null);
    const chosenCwd =
      input.cwd !== undefined ? trimOrNull(input.cwd) : (existingBinding?.cwd ?? null);
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
              command: chosenCommand,
              args: chosenArgs,
              env: chosenEnv,
              cwd: chosenCwd,
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
              command: chosenCommand,
              args: chosenArgs,
              env: chosenEnv,
              cwd: chosenCwd,
            },
            importAuthPolicy: "reuse_runtime",
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        });

    const persistedDraft = yield* input.sourceStore.persistSource(draftSource, {
      actorAccountId: input.actorAccountId,
    });
    yield* input.sourceCatalogSync.sync({
      source: persistedDraft,
      actorAccountId: input.actorAccountId,
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
          const connected = yield* updateSourceStatus(input.sourceStore, persistedDraft, {
            actorAccountId: input.actorAccountId,
            status: "connected",
            lastError: null,
            auth: { kind: "none" },
          });
          const indexed = yield* Effect.either(
            input.sourceCatalogSync.persistMcpCatalogSnapshotFromManifest({
              source: connected,
              manifest: result.manifest,
            }),
          );

          return yield* Either.match(indexed, {
            onLeft: (error) =>
              updateSourceStatus(input.sourceStore, connected, {
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
      return yield* runtimeEffectError("sources/source-auth-service", "Local executor server base URL is unavailable for source credential setup");
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

    const authRequiredSource = yield* updateSourceStatus(input.sourceStore, persistedDraft, {
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
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  sourceInput: ExecutorHttpEndpointSourceInput;
  storeSecretMaterial: StoreSecretMaterial;
  resolveSecretMaterial: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  baseUrl?: string | null;
}): Effect.Effect<ExecutorSourceAddResult, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const normalizedEndpoint = normalizeEndpoint(input.sourceInput.endpoint);
    const normalizedSpecUrl = input.sourceInput.kind === "openapi"
      ? normalizeEndpoint(input.sourceInput.specUrl)
      : null;
    const existingSources = yield* input.sourceStore.loadSourcesInWorkspace(
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

    const persistedDraft = yield* input.sourceStore.persistSource(draftSource, {
      actorAccountId: input.sourceInput.actorAccountId,
    });

    if (shouldPromptForExecutorHttpRuntimeCredentialSetup({
      existing,
      explicitAuthProvided: input.sourceInput.auth !== undefined,
      auth: persistedDraft.auth,
    })) {
      const requestBaseUrl = trimOrNull(input.baseUrl);
      const baseUrl = requestBaseUrl ?? input.getLocalServerBaseUrl?.() ?? null;
      if (baseUrl) {
        const oauthRequired = yield* startOauth2PkceSourceCredentialSetup({
          rows: input.rows,
          sourceStore: input.sourceStore,
          source: persistedDraft,
          actorAccountId: input.sourceInput.actorAccountId,
          executionId: input.sourceInput.executionId,
          interactionId: input.sourceInput.interactionId,
          baseUrl,
          redirectModeOverride: requestBaseUrl ? "app_callback" : undefined,
          storeSecretMaterial: input.storeSecretMaterial,
        });
        if (oauthRequired) {
          return oauthRequired;
        }
      }

      const authRequiredSource = yield* updateSourceStatus(input.sourceStore, persistedDraft, {
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
      input.sourceCatalogSync.sync({
        source: {
          ...persistedDraft,
          status: "connected",
        },
        actorAccountId: input.sourceInput.actorAccountId,
      }),
    );

    return yield* Either.match(synced, {
      onLeft: (error) =>
        isSourceCredentialRequiredError(error)
          ? updateSourceStatus(input.sourceStore, persistedDraft, {
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
          : updateSourceStatus(input.sourceStore, persistedDraft, {
              actorAccountId: input.sourceInput.actorAccountId,
              status: "error",
              lastError: error.message,
            }).pipe(
              Effect.zipRight(Effect.fail(error)),
            ),
      onRight: () =>
        updateSourceStatus(input.sourceStore, persistedDraft, {
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
  }).pipe(
    Effect.withSpan("source.connect.http", {
      attributes: {
        "executor.source.kind": input.sourceInput.kind,
        "executor.source.endpoint": input.sourceInput.endpoint,
        ...(input.sourceInput.namespace ? { "executor.source.namespace": input.sourceInput.namespace } : {}),
        ...(input.sourceInput.name ? { "executor.source.name": input.sourceInput.name } : {}),
      },
    }),
  );

const addExecutorGoogleDiscoverySource = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  sourceInput: Extract<ExecutorAddSourceInput, { kind: "google_discovery" }>;
  storeSecretMaterial: StoreSecretMaterial;
  resolveSecretMaterial: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  baseUrl?: string | null;
}): Effect.Effect<ExecutorSourceAddResult, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const normalizedService = input.sourceInput.service.trim();
    const normalizedVersion = input.sourceInput.version.trim();
    const normalizedDiscoveryUrl = normalizeEndpoint(
      trimOrNull(input.sourceInput.discoveryUrl)
        ?? defaultGoogleDiscoveryUrl(normalizedService, normalizedVersion),
    );
    const existingSources = yield* input.sourceStore.loadSourcesInWorkspace(
      input.sourceInput.workspaceId,
      {
        actorAccountId: input.sourceInput.actorAccountId,
      },
    );
    const existing = existingSources.find((source) => {
      if (source.kind !== "google_discovery") {
        return false;
      }

      const binding = source.binding;
      if (typeof binding.service !== "string" || typeof binding.version !== "string") {
        return false;
      }

      // Match on service + version only. Different discovery URL formats
      // (e.g. host-scoped "https://tasks.googleapis.com/$discovery/rest?version=v1"
      // vs directory "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest")
      // can refer to the same API, so requiring an exact URL match causes
      // duplicate sources.
      return binding.service.trim() === normalizedService
        && binding.version.trim() === normalizedVersion;
    });

    const chosenName =
      trimOrNull(input.sourceInput.name)
      ?? existing?.name
      ?? defaultGoogleDiscoverySourceName(normalizedService, normalizedVersion);
    const chosenNamespace =
      trimOrNull(input.sourceInput.namespace)
      ?? existing?.namespace
      ?? defaultGoogleDiscoveryNamespace(normalizedService);
    const existingScopes = Array.isArray(existing?.binding?.scopes)
      ? existing.binding.scopes as ReadonlyArray<string>
      : [];
    const chosenScopes = (input.sourceInput.scopes ?? existingScopes)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
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
            endpoint: normalizedDiscoveryUrl,
            namespace: chosenNamespace,
            status: "probing",
            enabled: true,
            binding: {
              service: normalizedService,
              version: normalizedVersion,
              discoveryUrl: normalizedDiscoveryUrl,
              defaultHeaders: existingBinding?.defaultHeaders ?? null,
              scopes: [...chosenScopes],
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
            kind: "google_discovery",
            endpoint: normalizedDiscoveryUrl,
            namespace: chosenNamespace,
            status: "probing",
            enabled: true,
            binding: {
              service: normalizedService,
              version: normalizedVersion,
              discoveryUrl: normalizedDiscoveryUrl,
              defaultHeaders: existingBinding?.defaultHeaders ?? null,
              scopes: [...chosenScopes],
            },
            importAuthPolicy: importAuth.importAuthPolicy,
            importAuth: importAuth.importAuth,
            auth,
          },
          now,
        });

    const persistedDraft = yield* input.sourceStore.persistSource(draftSource, {
      actorAccountId: input.sourceInput.actorAccountId,
    });
    const googleAdapter = getSourceAdapterForSource(persistedDraft);
    const providerAuthTarget = yield* resolveRuntimeProviderAuthTarget(persistedDraft);

    if (
      providerAuthTarget !== null
      && input.sourceInput.auth === undefined
      && persistedDraft.auth.kind === "none"
    ) {
      let workspaceOauthClient: ResolvedWorkspaceOauthClient | null = null;
      if (input.sourceInput.workspaceOauthClientId) {
        workspaceOauthClient = yield* resolveWorkspaceOauthClientById({
          rows: input.rows,
          workspaceId: persistedDraft.workspaceId,
          oauthClientId: input.sourceInput.workspaceOauthClientId,
          providerKey: providerAuthTarget.setupConfig.providerKey,
        });
      } else if (input.sourceInput.oauthClient) {
        workspaceOauthClient = yield* createWorkspaceOauthClient({
          rows: input.rows,
          workspaceId: persistedDraft.workspaceId,
          providerKey: providerAuthTarget.setupConfig.providerKey,
          oauthClient: input.sourceInput.oauthClient,
          label: `${chosenName} OAuth Client`,
          normalizeOauthClient: googleAdapter.normalizeOauthClientInput,
          storeSecretMaterial: input.storeSecretMaterial,
        });
      }

      if (workspaceOauthClient === null) {
        return yield* runtimeEffectError(
          "sources/source-auth-service",
          `${providerAuthTarget.setupConfig.providerKey} shared auth requires a workspace OAuth client`,
        );
      }

      const providerAuthResult = yield* connectSourcesWithProviderRuntimeAuth({
        rows: input.rows,
        sourceStore: input.sourceStore,
        sourceCatalogSync: input.sourceCatalogSync,
        workspaceId: persistedDraft.workspaceId,
        actorAccountId: input.sourceInput.actorAccountId,
        executionId: input.sourceInput.executionId,
        interactionId: input.sourceInput.interactionId,
        baseUrl: input.baseUrl,
        getLocalServerBaseUrl: input.getLocalServerBaseUrl,
        workspaceOauthClient,
        targets: [providerAuthTarget],
      });

      return providerAuthResult.kind === "connected"
        ? {
            kind: "connected",
            source: providerAuthResult.sources[0]!,
          } satisfies ExecutorSourceAddResult
        : {
            kind: "oauth_required",
            source: providerAuthResult.sources[0]!,
            sessionId: providerAuthResult.sessionId,
            authorizationUrl: providerAuthResult.authorizationUrl,
          } satisfies ExecutorSourceAddResult;
    }

    if (input.sourceInput.oauthClient) {
      yield* upsertSourceOauthClient({
        rows: input.rows,
        source: persistedDraft,
        oauthClient: input.sourceInput.oauthClient,
        storeSecretMaterial: input.storeSecretMaterial,
      });
    }

    if (shouldPromptForExecutorHttpRuntimeCredentialSetup({
      existing,
      explicitAuthProvided: input.sourceInput.auth !== undefined,
      auth: persistedDraft.auth,
    })) {
      const requestBaseUrl = trimOrNull(input.baseUrl);
      const baseUrl = requestBaseUrl ?? input.getLocalServerBaseUrl?.() ?? null;
      if (baseUrl) {
        const oauthRequired = yield* startOauth2PkceSourceCredentialSetup({
          rows: input.rows,
          sourceStore: input.sourceStore,
          source: persistedDraft,
          actorAccountId: input.sourceInput.actorAccountId,
          executionId: input.sourceInput.executionId,
          interactionId: input.sourceInput.interactionId,
          baseUrl,
          redirectModeOverride: requestBaseUrl ? "app_callback" : undefined,
          storeSecretMaterial: input.storeSecretMaterial,
        });
        if (oauthRequired) {
          return oauthRequired;
        }
      }

      const authRequiredSource = yield* updateSourceStatus(input.sourceStore, persistedDraft, {
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
      input.sourceCatalogSync.sync({
        source: {
          ...persistedDraft,
          status: "connected",
        },
        actorAccountId: input.sourceInput.actorAccountId,
      }),
    );

    return yield* Either.match(synced, {
      onLeft: (error) =>
        isSourceCredentialRequiredError(error)
          ? updateSourceStatus(input.sourceStore, persistedDraft, {
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
          : updateSourceStatus(input.sourceStore, persistedDraft, {
              actorAccountId: input.sourceInput.actorAccountId,
              status: "error",
              lastError: error.message,
            }).pipe(
              Effect.zipRight(Effect.fail(error)),
            ),
      onRight: () =>
        updateSourceStatus(input.sourceStore, persistedDraft, {
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

const connectGoogleDiscoveryBatchInternal = (input: {
  rows: ControlPlaneStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  sourceInput: ConnectGoogleDiscoveryBatchInput;
  getLocalServerBaseUrl?: () => string | undefined;
}): Effect.Effect<ConnectGoogleDiscoveryBatchResult, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    if (input.sourceInput.sources.length === 0) {
      return yield* runtimeEffectError("sources/source-auth-service", "Google batch connect requires at least one source");
    }

    const existingSources = yield* input.sourceStore.loadSourcesInWorkspace(
      input.sourceInput.workspaceId,
      {
        actorAccountId: input.sourceInput.actorAccountId,
      },
    );

    const persistedTargets = yield* Effect.forEach(
      input.sourceInput.sources,
      (sourceInput) =>
        Effect.gen(function* () {
          const normalizedService = sourceInput.service.trim();
          const normalizedVersion = sourceInput.version.trim();
          const normalizedDiscoveryUrl = normalizeEndpoint(
            trimOrNull(sourceInput.discoveryUrl)
              ?? defaultGoogleDiscoveryUrl(normalizedService, normalizedVersion),
          );
          const existing = existingSources.find((source) => {
            if (source.kind !== "google_discovery") {
              return false;
            }

            const binding = source.binding;
            return typeof binding.service === "string"
              && typeof binding.version === "string"
              && binding.service.trim() === normalizedService
              && binding.version.trim() === normalizedVersion;
          });
          const chosenName =
            trimOrNull(sourceInput.name)
            ?? existing?.name
            ?? defaultGoogleDiscoverySourceName(normalizedService, normalizedVersion);
          const chosenNamespace =
            trimOrNull(sourceInput.namespace)
            ?? existing?.namespace
            ?? defaultGoogleDiscoveryNamespace(normalizedService);
          const chosenScopes = normalizeScopes(
            sourceInput.scopes
              ?? (Array.isArray(existing?.binding.scopes)
                ? existing?.binding.scopes as ReadonlyArray<string>
                : []),
          );
          const existingBinding = existing
            ? yield* sourceBindingStateFromSource(existing)
            : null;
          const now = Date.now();

          const draftSource = existing
            ? yield* updateSourceFromPayload({
                source: existing,
                payload: {
                  name: chosenName,
                  endpoint: normalizedDiscoveryUrl,
                  namespace: chosenNamespace,
                  status: "probing",
                  enabled: true,
                  binding: {
                    service: normalizedService,
                    version: normalizedVersion,
                    discoveryUrl: normalizedDiscoveryUrl,
                    defaultHeaders: existingBinding?.defaultHeaders ?? null,
                    scopes: [...chosenScopes],
                  },
                  importAuthPolicy: "reuse_runtime",
                  importAuth: { kind: "none" },
                  auth: existing.auth.kind === "provider_grant_ref" ? existing.auth : { kind: "none" },
                  lastError: null,
                },
                now,
              })
            : yield* createSourceFromPayload({
                workspaceId: input.sourceInput.workspaceId,
                sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
                payload: {
                  name: chosenName,
                  kind: "google_discovery",
                  endpoint: normalizedDiscoveryUrl,
                  namespace: chosenNamespace,
                  status: "probing",
                  enabled: true,
                  binding: {
                    service: normalizedService,
                    version: normalizedVersion,
                    discoveryUrl: normalizedDiscoveryUrl,
                    defaultHeaders: existingBinding?.defaultHeaders ?? null,
                    scopes: [...chosenScopes],
                  },
                  importAuthPolicy: "reuse_runtime",
                  importAuth: { kind: "none" },
                  auth: { kind: "none" },
                },
                now,
              });

          const persistedDraft = yield* input.sourceStore.persistSource(draftSource, {
            actorAccountId: input.sourceInput.actorAccountId,
          });
          const providerAuthTarget = yield* resolveRuntimeProviderAuthTarget(persistedDraft);
          if (providerAuthTarget === null) {
            return yield* runtimeEffectError("sources/source-auth-service", `Source ${persistedDraft.id} does not support Google shared auth`);
          }

          return providerAuthTarget;
        }),
      { discard: false },
    );

    const workspaceOauthClient = yield* resolveWorkspaceOauthClientById({
      rows: input.rows,
      workspaceId: input.sourceInput.workspaceId,
      oauthClientId: input.sourceInput.workspaceOauthClientId,
      providerKey: persistedTargets[0]!.setupConfig.providerKey,
    });
    if (workspaceOauthClient === null) {
      return yield* runtimeEffectError("sources/source-auth-service", `Workspace OAuth client not found: ${input.sourceInput.workspaceOauthClientId}`);
    }

    const providerAuthResult = yield* connectSourcesWithProviderRuntimeAuth({
      rows: input.rows,
      sourceStore: input.sourceStore,
      sourceCatalogSync: input.sourceCatalogSync,
      workspaceId: input.sourceInput.workspaceId,
      actorAccountId: input.sourceInput.actorAccountId,
      executionId: input.sourceInput.executionId,
      interactionId: input.sourceInput.interactionId,
      baseUrl: input.sourceInput.baseUrl,
      getLocalServerBaseUrl: input.getLocalServerBaseUrl,
      workspaceOauthClient,
      targets: persistedTargets,
    });

    if (providerAuthResult.kind === "connected") {
      return {
        results: providerAuthResult.sources.map((source) => ({
          source,
          status: "connected" as const,
        })),
        providerOauthSession: null,
      };
    }

    return {
      results: providerAuthResult.sources.map((source) => ({
        source,
        status: "pending_oauth" as const,
      })),
      providerOauthSession: {
        sessionId: providerAuthResult.sessionId,
        authorizationUrl: providerAuthResult.authorizationUrl,
        sourceIds: providerAuthResult.sources.map((source) => source.id),
      },
    };
  });

type RuntimeSourceAuthServiceShape = {
  getSourceById: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<Source, Error, WorkspaceStorageServices>;
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
  ) => Effect.Effect<ExecutorSourceAddResult, Error, WorkspaceStorageServices>;
  connectGoogleDiscoveryBatch: (
    input: ConnectGoogleDiscoveryBatchInput,
  ) => Effect.Effect<ConnectGoogleDiscoveryBatchResult, Error, WorkspaceStorageServices>;
  connectMcpSource: (
    input: ConnectMcpSourceInput,
  ) => Effect.Effect<McpSourceConnectResult, Error, WorkspaceStorageServices>;
  listWorkspaceOauthClients: (input: {
    workspaceId: WorkspaceId;
    providerKey: string;
  }) => Effect.Effect<readonly WorkspaceOauthClient[], Error, WorkspaceStorageServices>;
  createWorkspaceOauthClient: (
    input: CreateWorkspaceOauthClientInput,
  ) => Effect.Effect<WorkspaceOauthClient, Error, WorkspaceStorageServices>;
  removeWorkspaceOauthClient: (input: {
    workspaceId: WorkspaceId;
    oauthClientId: WorkspaceOauthClient["id"];
  }) => Effect.Effect<boolean, Error, WorkspaceStorageServices>;
  removeProviderAuthGrant: (input: {
    workspaceId: WorkspaceId;
    grantId: ProviderAuthGrant["id"];
  }) => Effect.Effect<boolean, Error, WorkspaceStorageServices>;
  startSourceOAuthSession: (
    input: StartSourceOAuthSessionInput,
  ) => Effect.Effect<StartSourceOAuthSessionResult, Error, never>;
  completeSourceOAuthSession: (input: {
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteSourceOAuthSessionResult, Error, WorkspaceStorageServices>;
  completeProviderOauthCallback: (input: {
    workspaceId: WorkspaceId;
    actorAccountId?: AccountId | null;
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteProviderOauthCallbackResult, Error, WorkspaceStorageServices>;
  completeSourceCredentialSetup: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteSourceCredentialSetupResult, Error, WorkspaceStorageServices>;
};

type RuntimeSourceAuthDependencies = {
  rows: ControlPlaneStoreShape;
  liveExecutionManager: LiveExecutionManager;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  localWorkspaceState?: RuntimeLocalWorkspaceState;
};

type ProvideLocalWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

type RuntimeSourceConnectionServiceShape = Pick<
  RuntimeSourceAuthServiceShape,
  | "getSourceById"
  | "addExecutorSource"
  | "connectGoogleDiscoveryBatch"
  | "connectMcpSource"
  | "listWorkspaceOauthClients"
  | "createWorkspaceOauthClient"
  | "removeWorkspaceOauthClient"
  | "removeProviderAuthGrant"
>;

type RuntimeSourceOAuthSessionServiceShape = Pick<
  RuntimeSourceAuthServiceShape,
  | "startSourceOAuthSession"
  | "completeSourceOAuthSession"
  | "completeProviderOauthCallback"
  | "completeSourceCredentialSetup"
>;

const createRuntimeSourceConnectionService = (
  input: RuntimeSourceAuthDependencies,
  provideLocalWorkspace: ProvideLocalWorkspace,
): RuntimeSourceConnectionServiceShape => {
  const mirrorLocalSourceResult = (
    result: ExecutorSourceAddResult,
  ): Effect.Effect<ExecutorSourceAddResult, Error, WorkspaceStorageServices> =>
    Effect.succeed(result);
  const mirrorLocalMcpSourceResult = (
    result: McpSourceConnectResult,
  ): Effect.Effect<McpSourceConnectResult, Error, WorkspaceStorageServices> =>
    Effect.succeed(result);

  return {
    getSourceById: ({ workspaceId, sourceId, actorAccountId }) =>
      provideLocalWorkspace(
        input.sourceStore.loadSourceById({
          workspaceId,
          sourceId,
          actorAccountId,
        }),
      ),

    addExecutorSource: (sourceInput, options = undefined) =>
      provideLocalWorkspace(
        (isExecutorGoogleDiscoverySourceInput(sourceInput)
          ? addExecutorGoogleDiscoverySource({
              rows: input.rows,
              sourceStore: input.sourceStore,
              sourceCatalogSync: input.sourceCatalogSync,
              sourceInput,
              storeSecretMaterial: input.storeSecretMaterial,
              resolveSecretMaterial: input.resolveSecretMaterial,
              getLocalServerBaseUrl: input.getLocalServerBaseUrl,
              baseUrl: options?.baseUrl,
            })
          : isExecutorHttpEndpointSourceInput(sourceInput)
          ? addExecutorHttpSource({
              rows: input.rows,
              sourceStore: input.sourceStore,
              sourceCatalogSync: input.sourceCatalogSync,
              sourceInput,
              storeSecretMaterial: input.storeSecretMaterial,
              resolveSecretMaterial: input.resolveSecretMaterial,
              getLocalServerBaseUrl: input.getLocalServerBaseUrl,
              baseUrl: options?.baseUrl,
            })
          : isExecutorMcpSourceInput(sourceInput)
          ? connectMcpSourceInternal({
              rows: input.rows,
              sourceStore: input.sourceStore,
              sourceCatalogSync: input.sourceCatalogSync,
              getLocalServerBaseUrl: input.getLocalServerBaseUrl,
              workspaceId: sourceInput.workspaceId,
              actorAccountId: sourceInput.actorAccountId,
              executionId: sourceInput.executionId,
              interactionId: sourceInput.interactionId,
              endpoint: sourceInput.endpoint,
              name: sourceInput.name,
              namespace: sourceInput.namespace,
              transport: sourceInput.transport,
              queryParams: sourceInput.queryParams,
              headers: sourceInput.headers,
              command: sourceInput.command,
              args: sourceInput.args,
              env: sourceInput.env,
              cwd: sourceInput.cwd,
              mcpDiscoveryElicitation: options?.mcpDiscoveryElicitation,
              baseUrl: options?.baseUrl,
              resolveSecretMaterial: input.resolveSecretMaterial,
            })
          : Effect.fail(runtimeEffectError("sources/source-auth-service", `Unsupported executor source input: ${JSON.stringify(sourceInput)}`))).pipe(
              Effect.flatMap(mirrorLocalSourceResult),
            ),
      ),

    connectGoogleDiscoveryBatch: (sourceInput) =>
      provideLocalWorkspace(
        connectGoogleDiscoveryBatchInternal({
          rows: input.rows,
          sourceStore: input.sourceStore,
          sourceCatalogSync: input.sourceCatalogSync,
          sourceInput,
          getLocalServerBaseUrl: input.getLocalServerBaseUrl,
        }),
      ),

    connectMcpSource: (sourceInput) =>
      provideLocalWorkspace(
        connectMcpSourceInternal({
          rows: input.rows,
          sourceStore: input.sourceStore,
          sourceCatalogSync: input.sourceCatalogSync,
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
          command: sourceInput.command,
          args: sourceInput.args,
          env: sourceInput.env,
          cwd: sourceInput.cwd,
          baseUrl: sourceInput.baseUrl,
          resolveSecretMaterial: input.resolveSecretMaterial,
        }).pipe(
          Effect.flatMap(mirrorLocalMcpSourceResult),
        ),
      ),

    listWorkspaceOauthClients: ({ workspaceId, providerKey }) =>
      provideLocalWorkspace(
        input.rows.workspaceOauthClients.listByWorkspaceAndProvider({
          workspaceId,
          providerKey,
        }),
      ),

    createWorkspaceOauthClient: ({ workspaceId, providerKey, label, oauthClient }) =>
      provideLocalWorkspace(
        Effect.gen(function* () {
          const sourceAdapter = findSourceAdapterByProviderKey(providerKey);
          const created = yield* createWorkspaceOauthClient({
            rows: input.rows,
            workspaceId,
            providerKey,
            oauthClient,
            label,
            normalizeOauthClient: sourceAdapter?.normalizeOauthClientInput,
            storeSecretMaterial: input.storeSecretMaterial,
          });
          const stored = yield* input.rows.workspaceOauthClients.getById(created.id);
          if (Option.isNone(stored)) {
            return yield* runtimeEffectError("sources/source-auth-service", `Workspace OAuth client ${created.id} was not persisted`);
          }

          return stored.value;
        }),
      ),

    removeWorkspaceOauthClient: ({ workspaceId, oauthClientId }) =>
      provideLocalWorkspace(
        Effect.gen(function* () {
          const oauthClient = yield* input.rows.workspaceOauthClients.getById(oauthClientId);
          if (Option.isNone(oauthClient) || oauthClient.value.workspaceId !== workspaceId) {
            return false;
          }

          const grants = yield* input.rows.providerAuthGrants.listByWorkspaceId(workspaceId);
          const dependentGrant = grants.find((grant) => grant.oauthClientId === oauthClientId);
          if (dependentGrant) {
            return yield* runtimeEffectError("sources/source-auth-service", 
                `Workspace OAuth client ${oauthClientId} is still referenced by provider grant ${dependentGrant.id}`,
              );
          }

          const secretRef = sourceOauthClientSecretRef(oauthClient.value);
          const removed = yield* input.rows.workspaceOauthClients.removeById(oauthClientId);
          if (removed && secretRef) {
            const deleteSecretMaterial = createDefaultSecretMaterialDeleter({
              rows: input.rows,
            });
            yield* deleteSecretMaterial(secretRef).pipe(
              Effect.either,
              Effect.ignore,
            );
          }

          return removed;
        }),
      ),

    removeProviderAuthGrant: ({ workspaceId, grantId }) =>
      provideLocalWorkspace(
        removeProviderAuthGrantInternal({
          rows: input.rows,
          sourceStore: input.sourceStore,
          workspaceId,
          grantId,
        }),
      ),
  };
};

const createRuntimeSourceOAuthSessionService = (
  input: RuntimeSourceAuthDependencies,
  provideLocalWorkspace: ProvideLocalWorkspace,
): RuntimeSourceOAuthSessionServiceShape => ({
  startSourceOAuthSession: (oauthInput) =>
    Effect.gen(function* () {
      const resolvedBaseUrl = trimOrNull(oauthInput.baseUrl) ?? input.getLocalServerBaseUrl?.() ?? null;
      if (!resolvedBaseUrl) {
        return yield* runtimeEffectError("sources/source-auth-service", "Local executor server base URL is unavailable for OAuth setup");
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

  completeSourceOAuthSession: ({ state, code, error, errorDescription }) =>
    provideLocalWorkspace(Effect.gen(function* () {
      const sessionOption = yield* input.rows.sourceAuthSessions.getByState(state);
      if (Option.isNone(sessionOption)) {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session not found for state ${state}`);
      }

      const session = sessionOption.value;
      const sessionData = decodeMcpSourceAuthSessionData(session);
      if (session.status === "completed") {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} is already completed`);
      }

      if (session.status !== "pending") {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} is not pending`);
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

        return yield* runtimeEffectError("sources/source-auth-service", reason);
      }

      const authorizationCode = trimOrNull(code);
      if (authorizationCode === null) {
        return yield* runtimeEffectError("sources/source-auth-service", "Missing OAuth authorization code");
      }

      if (sessionData.codeVerifier === null) {
        return yield* runtimeEffectError("sources/source-auth-service", "OAuth session is missing the PKCE code verifier");
      }

      if (sessionData.scope !== null && sessionData.scope !== "mcp") {
        return yield* runtimeEffectError("sources/source-auth-service", `Unsupported OAuth provider: ${sessionData.scope}`);
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
      const accessTokenRef = yield* input.storeSecretMaterial({
        purpose: "oauth_access_token",
        value: exchanged.tokens.access_token,
        name: oauthSecretName,
      });
      const refreshTokenRef = exchanged.tokens.refresh_token
        ? yield* input.storeSecretMaterial({
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
    })),

  completeProviderOauthCallback: ({ workspaceId, actorAccountId, state, code, error, errorDescription }) =>
    provideLocalWorkspace(Effect.gen(function* () {
      const sessionOption = yield* input.rows.sourceAuthSessions.getByState(state);
      if (Option.isNone(sessionOption)) {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session not found for state ${state}`);
      }

      const session = sessionOption.value;
      if (session.workspaceId !== workspaceId) {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} does not match workspaceId=${workspaceId}`);
      }
      if ((session.actorAccountId ?? null) !== (actorAccountId ?? null)) {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} does not match the active account`);
      }
      if (session.providerKind !== "oauth2_provider_batch") {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} is not a provider batch OAuth session`);
      }
      if (session.status === "completed") {
        const sessionData = decodeProviderOauthBatchSourceAuthSessionData(session);
        const sources = yield* Effect.forEach(
          sessionData.targetSources,
          (target) =>
            input.sourceStore.loadSourceById({
              workspaceId,
              sourceId: target.sourceId,
              actorAccountId,
            }),
          { discard: false },
        );
        return {
          sessionId: session.id,
          sources,
        } satisfies CompleteProviderOauthCallbackResult;
      }
      if (session.status !== "pending") {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} is not pending`);
      }

      const sessionData = decodeProviderOauthBatchSourceAuthSessionData(session);
      if (trimOrNull(error) !== null) {
        const reason = trimOrNull(errorDescription) ?? trimOrNull(error) ?? "OAuth authorization failed";
        yield* input.rows.sourceAuthSessions.update(
          session.id,
          createTerminalSourceAuthSessionPatch({
            sessionDataJson: session.sessionDataJson,
            status: "failed",
            now: Date.now(),
            errorText: reason,
          }),
        );
        return yield* runtimeEffectError("sources/source-auth-service", reason);
      }

      const authorizationCode = trimOrNull(code);
      if (authorizationCode === null) {
        return yield* runtimeEffectError("sources/source-auth-service", "Missing OAuth authorization code");
      }
      if (sessionData.codeVerifier === null) {
        return yield* runtimeEffectError("sources/source-auth-service", "OAuth session is missing the PKCE code verifier");
      }

      const oauthClient = yield* resolveWorkspaceOauthClientById({
        rows: input.rows,
        workspaceId,
        oauthClientId: sessionData.oauthClientId,
        providerKey: sessionData.providerKey,
      });
      if (oauthClient === null) {
        return yield* runtimeEffectError("sources/source-auth-service", `Workspace OAuth client not found: ${sessionData.oauthClientId}`);
      }

      let clientSecret: string | null = null;
      if (oauthClient.clientSecret) {
        clientSecret = yield* input.resolveSecretMaterial({
          ref: oauthClient.clientSecret,
        });
      }

      const exchanged = yield* exchangeOAuth2AuthorizationCode({
        tokenEndpoint: sessionData.tokenEndpoint,
        clientId: oauthClient.clientId,
        clientAuthentication: sessionData.clientAuthentication,
        clientSecret,
        redirectUri: sessionData.redirectUri,
        codeVerifier: sessionData.codeVerifier ?? "",
        code: authorizationCode,
      });

      const availableGrants = yield* input.rows.providerAuthGrants.listByWorkspaceActorAndProvider({
        workspaceId,
        actorAccountId: actorAccountId ?? null,
        providerKey: sessionData.providerKey,
      });
      const existingGrant = availableGrants.find(
        (grant) => grant.oauthClientId === sessionData.oauthClientId,
      ) ?? null;

      const grantedScopes = normalizeScopes(
        trimOrNull(exchanged.scope)
          ? exchanged.scope!.split(/\s+/)
          : sessionData.scopes,
      );
      const nextGrant = yield* upsertProviderAuthGrant({
        rows: input.rows,
        workspaceId,
        actorAccountId,
        providerKey: sessionData.providerKey,
        oauthClientId: sessionData.oauthClientId,
        tokenEndpoint: sessionData.tokenEndpoint,
        clientAuthentication: sessionData.clientAuthentication,
        headerName: sessionData.headerName,
        prefix: sessionData.prefix,
        grantedScopes,
        refreshToken: trimOrNull(exchanged.refresh_token),
        existingGrant,
        storeSecretMaterial: input.storeSecretMaterial,
      });

      const targets = yield* Effect.forEach(
        sessionData.targetSources,
        (target) =>
          Effect.map(
            input.sourceStore.loadSourceById({
              workspaceId,
              sourceId: target.sourceId,
              actorAccountId,
            }),
            (source) => ({
              source,
              requiredScopes: target.requiredScopes,
            }),
          ),
        { discard: false },
      );

      const connectedSources = yield* attachProviderGrantToSources({
        sourceStore: input.sourceStore,
        sourceCatalogSync: input.sourceCatalogSync,
        actorAccountId,
        grantId: nextGrant.id,
        providerKey: nextGrant.providerKey,
        headerName: nextGrant.headerName,
        prefix: nextGrant.prefix,
        targets,
      });

      yield* input.rows.sourceAuthSessions.update(
        session.id,
        createTerminalSourceAuthSessionPatch({
          sessionDataJson: mergeProviderOauthBatchSourceAuthSessionData({
            session,
            patch: {
              codeVerifier: null,
              authorizationUrl: null,
            },
          }),
          status: "completed",
          now: Date.now(),
          errorText: null,
        }),
      );

      return {
        sessionId: session.id,
        sources: connectedSources,
      } satisfies CompleteProviderOauthCallbackResult;
    })),

  completeSourceCredentialSetup: ({ workspaceId, sourceId, actorAccountId, state, code, error, errorDescription }) =>
    provideLocalWorkspace(Effect.gen(function* () {
      const sessionOption = yield* input.rows.sourceAuthSessions.getByState(state);
      if (Option.isNone(sessionOption)) {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session not found for state ${state}`);
      }

      const session = sessionOption.value;
      if (session.workspaceId !== workspaceId || session.sourceId !== sourceId) {
        return yield* runtimeEffectError("sources/source-auth-service", 
            `Source auth session ${session.id} does not match workspaceId=${workspaceId} sourceId=${sourceId}`,
          );
      }
      if (
        actorAccountId !== undefined
        && (session.actorAccountId ?? null) !== (actorAccountId ?? null)
      ) {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} does not match the active account`);
      }

      const source = yield* input.sourceStore.loadSourceById({
        workspaceId: session.workspaceId,
        sourceId: session.sourceId,
        actorAccountId: session.actorAccountId,
      });

      if (session.status === "completed") {
        return {
          sessionId: session.id,
          source,
        } satisfies CompleteSourceCredentialSetupResult;
      }

      if (session.status !== "pending") {
        return yield* runtimeEffectError("sources/source-auth-service", `Source auth session ${session.id} is not pending`);
      }

      const sessionData = session.providerKind === "oauth2_pkce"
        ? decodeOauth2PkceSourceAuthSessionData(session)
        : decodeMcpSourceAuthSessionData(session);

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
        const failedSource = yield* updateSourceStatus(input.sourceStore, source, {
          actorAccountId: session.actorAccountId,
          status: "error",
          lastError: reason,
        });
        yield* input.sourceCatalogSync.sync({
          source: failedSource,
          actorAccountId: session.actorAccountId,
        });
        yield* completeLiveInteraction({
          rows: input.rows,
          liveExecutionManager: input.liveExecutionManager,
          session,
          response: {
            action: "cancel",
            reason,
          },
        });

        return yield* runtimeEffectError("sources/source-auth-service", reason);
      }

      const authorizationCode = trimOrNull(code);
      if (authorizationCode === null) {
        return yield* runtimeEffectError("sources/source-auth-service", "Missing OAuth authorization code");
      }

      if (sessionData.codeVerifier === null) {
        return yield* runtimeEffectError("sources/source-auth-service", "OAuth session is missing the PKCE code verifier");
      }

      const now = Date.now();
      let connectedSource: Source;
      if (session.providerKind === "oauth2_pkce") {
        const oauthSessionData = decodeOauth2PkceSourceAuthSessionData(session);
        let clientSecret: string | null = null;
        if (oauthSessionData.clientSecret) {
          clientSecret = yield* input.resolveSecretMaterial({
            ref: oauthSessionData.clientSecret,
          });
        }

        const exchanged = yield* exchangeOAuth2AuthorizationCode({
          tokenEndpoint: oauthSessionData.tokenEndpoint,
          clientId: oauthSessionData.clientId,
          clientAuthentication: oauthSessionData.clientAuthentication,
          clientSecret,
          redirectUri: oauthSessionData.redirectUri,
          codeVerifier: oauthSessionData.codeVerifier ?? "",
          code: authorizationCode,
        });
        const refreshToken = trimOrNull(exchanged.refresh_token);
        if (refreshToken === null) {
          return yield* runtimeEffectError("sources/source-auth-service", "OAuth authorization did not return a refresh token");
        }

        const refreshTokenRef = yield* input.storeSecretMaterial({
          purpose: "oauth_refresh_token",
          value: refreshToken,
          name: `${source.name} Refresh`,
        });
        const grantedScopes = trimOrNull(exchanged.scope)
          ? exchanged.scope!.split(/\s+/).filter((scope) => scope.length > 0)
          : [...oauthSessionData.scopes];
        connectedSource = yield* updateSourceStatus(input.sourceStore, source, {
          actorAccountId: session.actorAccountId,
          status: "connected",
          lastError: null,
          auth: {
            kind: "oauth2_authorized_user",
            headerName: oauthSessionData.headerName,
            prefix: oauthSessionData.prefix,
            tokenEndpoint: oauthSessionData.tokenEndpoint,
            clientId: oauthSessionData.clientId,
            clientAuthentication: oauthSessionData.clientAuthentication,
            clientSecret: oauthSessionData.clientSecret,
            refreshToken: refreshTokenRef,
            grantSet: grantedScopes,
          },
        });
        const authArtifact = yield* input.rows.authArtifacts.getByWorkspaceSourceAndActor({
          workspaceId: connectedSource.workspaceId,
          sourceId: connectedSource.id,
          actorAccountId: session.actorAccountId ?? null,
          slot: "runtime",
        });
        if (Option.isSome(authArtifact)) {
          yield* upsertOauth2AuthorizedUserLeaseFromTokenResponse({
            rows: input.rows,
            artifact: authArtifact.value,
            tokenResponse: exchanged,
          });
        }

        yield* input.rows.sourceAuthSessions.update(
          session.id,
          createTerminalSourceAuthSessionPatch({
            sessionDataJson: mergeOauth2PkceSourceAuthSessionData({
              session,
              patch: {
                codeVerifier: null,
                authorizationUrl: null,
              },
            }),
            status: "completed",
            now,
            errorText: null,
          }),
        );
      } else {
        const mcpSessionData = decodeMcpSourceAuthSessionData(session);
        const exchanged = yield* exchangeMcpOAuthAuthorizationCode({
          session: {
            endpoint: mcpSessionData.endpoint,
            redirectUrl: mcpSessionData.redirectUri,
            codeVerifier: mcpSessionData.codeVerifier ?? "",
            resourceMetadataUrl: mcpSessionData.resourceMetadataUrl,
            authorizationServerUrl: mcpSessionData.authorizationServerUrl,
            resourceMetadata: mcpSessionData.resourceMetadata,
            authorizationServerMetadata: mcpSessionData.authorizationServerMetadata,
            clientInformation: mcpSessionData.clientInformation,
          },
          code: authorizationCode,
        });

        const oauthSecretName = resolveSourceOAuthSecretName({
          displayName: source.name,
          endpoint: source.endpoint,
        });
        const accessTokenRef = yield* input.storeSecretMaterial({
          purpose: "oauth_access_token",
          value: exchanged.tokens.access_token,
          name: oauthSecretName,
        });
        const refreshTokenRef = exchanged.tokens.refresh_token
          ? yield* input.storeSecretMaterial({
              purpose: "oauth_refresh_token",
              value: exchanged.tokens.refresh_token,
              name: `${oauthSecretName} Refresh`,
            })
          : null;

        connectedSource = yield* updateSourceStatus(input.sourceStore, source, {
          actorAccountId: session.actorAccountId,
          status: "connected",
          lastError: null,
          auth: createPersistedMcpOAuthSourceAuth({
            redirectUri: mcpSessionData.redirectUri,
            accessToken: accessTokenRef,
            refreshToken: refreshTokenRef,
            tokenType: exchanged.tokens.token_type,
            expiresIn:
              typeof exchanged.tokens.expires_in === "number"
              && Number.isFinite(exchanged.tokens.expires_in)
                ? exchanged.tokens.expires_in
                : null,
            scope: exchanged.tokens.scope ?? null,
            resourceMetadataUrl: exchanged.resourceMetadataUrl,
            authorizationServerUrl: exchanged.authorizationServerUrl,
            resourceMetadata: exchanged.resourceMetadata,
            authorizationServerMetadata: exchanged.authorizationServerMetadata,
            clientInformation: exchanged.clientInformation,
          }),
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
      }
      const indexed = yield* Effect.either(
        input.sourceCatalogSync.sync({
          source: connectedSource,
          actorAccountId: session.actorAccountId,
        }),
      );
      yield* Either.match(indexed, {
        onLeft: (error) =>
          updateSourceStatus(input.sourceStore, connectedSource, {
            actorAccountId: session.actorAccountId,
            status: "error",
            lastError: error.message,
          }).pipe(
            Effect.zipRight(Effect.fail(error)),
          ),
        onRight: () => Effect.succeed(undefined),
      });

      yield* completeLiveInteraction({
        rows: input.rows,
        liveExecutionManager: input.liveExecutionManager,
        session,
        response: {
          action: "accept",
        },
      });

      return {
        sessionId: session.id,
        source: connectedSource,
      } satisfies CompleteSourceCredentialSetupResult;
    })),
});

export const createRuntimeSourceAuthService = (input: RuntimeSourceAuthDependencies) => {
  const provideLocalWorkspace: ProvideLocalWorkspace = (effect) =>
    provideOptionalRuntimeLocalWorkspace(effect, input.localWorkspaceState);
  const sourceConnection = createRuntimeSourceConnectionService(
    input,
    provideLocalWorkspace,
  );
  const sourceOAuthSessions = createRuntimeSourceOAuthSessionService(
    input,
    provideLocalWorkspace,
  );

  return {
    getLocalServerBaseUrl: () => input.getLocalServerBaseUrl?.() ?? null,

    storeSecretMaterial: ({ purpose, value }) =>
      input.storeSecretMaterial({
        purpose,
        value,
      }),

    ...sourceConnection,
    ...sourceOAuthSessions,
  } satisfies RuntimeSourceAuthServiceShape;
};

export type RuntimeSourceAuthService = RuntimeSourceAuthServiceShape;

export class RuntimeSourceAuthServiceTag extends Context.Tag(
  "#runtime/RuntimeSourceAuthServiceTag",
)<RuntimeSourceAuthServiceTag, RuntimeSourceAuthService>() {}

export const RuntimeSourceAuthServiceLive = (input: {
  getLocalServerBaseUrl?: () => string | undefined;
} = {}) =>
  Layer.effect(
    RuntimeSourceAuthServiceTag,
    Effect.gen(function* () {
      const rows = yield* ControlPlaneStore;
      const liveExecutionManager = yield* LiveExecutionManagerService;
      const sourceStore = yield* RuntimeSourceStoreService;
      const sourceCatalogSync = yield* RuntimeSourceCatalogSyncService;
      const resolveSecretMaterial = yield* SecretMaterialResolverService;
      const storeSecretMaterial = yield* SecretMaterialStorerService;
      const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();

      return createRuntimeSourceAuthService({
        rows,
        liveExecutionManager,
        sourceStore,
        sourceCatalogSync,
        resolveSecretMaterial,
        storeSecretMaterial,
        getLocalServerBaseUrl: input.getLocalServerBaseUrl,
        localWorkspaceState: runtimeLocalWorkspace ?? undefined,
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
