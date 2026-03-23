import type {
  CredentialSlot,
  SecretRef,
} from "@executor/source-core";
import {
  type ProviderAuthGrant,
  type ScopeId,
  type ScopeOauthClient,
  type Source,
  type SourceAuthSession,
  SourceAuthSessionIdSchema,
  SourceSchema,
  type SourceOauthClientInput,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  LiveExecutionManagerService,
  type LiveExecutionManager,
} from "../execution/live";
import {
  getRuntimeLocalScopeOption,
  provideOptionalRuntimeLocalScope,
  type RuntimeLocalScopeState,
} from "../scope/runtime-context";
import {
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  type StoreSecretMaterial,
} from "../scope/secret-material-providers";
import {
  RuntimeSourceCatalogSyncService,
  type RuntimeSourceCatalogSyncShape,
} from "../catalog/source/sync";
import {
  type RuntimeSourceStore,
  RuntimeSourceStoreService,
} from "./source-store";
import type {
  ScopeStorageServices,
} from "../scope/storage";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../executor-state-store";
import {
  runtimeEffectError,
} from "../effect-errors";
import type {
  ExecutorAddSourceInput as RegisteredExecutorAddSourceInput,
} from "./source-adapters";

const SOURCE_PLUGINS_REMOVED_MESSAGE =
  "Source plugins and legacy source adapters have been removed from this build.";

const sourcePluginsRemovedError = (
  operation: string,
) => runtimeEffectError("sources/source-auth-service", `${operation}: ${SOURCE_PLUGINS_REMOVED_MESSAGE}`);

const disabledSourcePlugins = <A>(
  operation: string,
): Effect.Effect<A, Error, never> =>
  Effect.fail(sourcePluginsRemovedError(operation));

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

export type ExecutorAddSourceInput = RegisteredExecutorAddSourceInput & {
  scopeId: ScopeId;
  actorScopeId?: ScopeId | null;
  executionId: SourceAuthSession["executionId"];
  interactionId: SourceAuthSession["interactionId"];
};

export type CreateScopeOauthClientInput = {
  scopeId: ScopeId;
  providerKey: string;
  label?: string | null;
  oauthClient: SourceOauthClientInput;
};

export type SourceOAuthProviderInput = {
  providerKey: string;
  config?: Record<string, unknown> | null;
};

export type StartSourceOAuthSessionInput = {
  scopeId: ScopeId;
  actorScopeId?: ScopeId | null;
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

export type CompleteSourceCredentialSetupResult = {
  sessionId: SourceAuthSession["id"];
  source: Source;
};

export type CompleteProviderOauthCallbackResult = {
  sessionId: SourceAuthSession["id"];
  sources: ReadonlyArray<Source>;
};

type RuntimeSourceAuthServiceShape = {
  getSourceById: (input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
    actorScopeId?: ScopeId | null;
  }) => Effect.Effect<Source, Error, ScopeStorageServices>;
  getLocalServerBaseUrl: () => string | null;
  storeSecretMaterial: (input: {
    purpose: Parameters<StoreSecretMaterial>[0]["purpose"];
    value: string;
  }) => Effect.Effect<SecretRef, Error, never>;
  addExecutorSource: (
    input: ExecutorAddSourceInput,
    options?: {
      mcpDiscoveryElicitation?: unknown;
      baseUrl?: string | null;
    },
  ) => Effect.Effect<ExecutorSourceAddResult, Error, ScopeStorageServices>;
  listScopeOauthClients: (input: {
    scopeId: ScopeId;
    providerKey: string;
  }) => Effect.Effect<readonly ScopeOauthClient[], Error, ScopeStorageServices>;
  createScopeOauthClient: (
    input: CreateScopeOauthClientInput,
  ) => Effect.Effect<ScopeOauthClient, Error, ScopeStorageServices>;
  removeScopeOauthClient: (input: {
    scopeId: ScopeId;
    oauthClientId: ScopeOauthClient["id"];
  }) => Effect.Effect<boolean, Error, ScopeStorageServices>;
  removeProviderAuthGrant: (input: {
    scopeId: ScopeId;
    grantId: ProviderAuthGrant["id"];
  }) => Effect.Effect<boolean, Error, ScopeStorageServices>;
  startSourceOAuthSession: (
    input: StartSourceOAuthSessionInput,
  ) => Effect.Effect<StartSourceOAuthSessionResult, Error, never>;
  completeSourceOAuthSession: (input: {
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteSourceOAuthSessionResult, Error, ScopeStorageServices>;
  completeProviderOauthCallback: (input: {
    scopeId: ScopeId;
    actorScopeId?: ScopeId | null;
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteProviderOauthCallbackResult, Error, ScopeStorageServices>;
  completeSourceCredentialSetup: (input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
    actorScopeId?: ScopeId | null;
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }) => Effect.Effect<CompleteSourceCredentialSetupResult, Error, ScopeStorageServices>;
};

type RuntimeSourceAuthDependencies = {
  executorState: ExecutorStateStoreShape;
  liveExecutionManager: LiveExecutionManager;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSync: RuntimeSourceCatalogSyncShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  localScopeState?: RuntimeLocalScopeState;
};

export const createRuntimeSourceAuthService = (
  input: RuntimeSourceAuthDependencies,
): RuntimeSourceAuthService => {
  const provideLocalWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provideOptionalRuntimeLocalScope(effect, input.localScopeState);

  return {
    getSourceById: ({ scopeId, sourceId, actorScopeId }) =>
      provideLocalWorkspace(
        input.sourceStore.loadSourceById({
          scopeId,
          sourceId,
          actorScopeId,
        }),
      ),
    getLocalServerBaseUrl: () => input.getLocalServerBaseUrl?.() ?? null,
    storeSecretMaterial: ({ purpose, value }) =>
      input.storeSecretMaterial({
        purpose,
        value,
      }),
    addExecutorSource: () =>
      provideLocalWorkspace(disabledSourcePlugins("addExecutorSource")),
    listScopeOauthClients: () => provideLocalWorkspace(Effect.succeed([])),
    createScopeOauthClient: () =>
      provideLocalWorkspace(disabledSourcePlugins("createScopeOauthClient")),
    removeScopeOauthClient: () => provideLocalWorkspace(Effect.succeed(false)),
    removeProviderAuthGrant: () => provideLocalWorkspace(Effect.succeed(false)),
    startSourceOAuthSession: () => disabledSourcePlugins("startSourceOAuthSession"),
    completeSourceOAuthSession: () =>
      provideLocalWorkspace(disabledSourcePlugins("completeSourceOAuthSession")),
    completeProviderOauthCallback: () =>
      provideLocalWorkspace(disabledSourcePlugins("completeProviderOauthCallback")),
    completeSourceCredentialSetup: () =>
      provideLocalWorkspace(disabledSourcePlugins("completeSourceCredentialSetup")),
  };
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
      const executorState = yield* ExecutorStateStore;
      const liveExecutionManager = yield* LiveExecutionManagerService;
      const sourceStore = yield* RuntimeSourceStoreService;
      const sourceCatalogSync = yield* RuntimeSourceCatalogSyncService;
      const resolveSecretMaterial = yield* SecretMaterialResolverService;
      const storeSecretMaterial = yield* SecretMaterialStorerService;
      const deleteSecretMaterial = yield* SecretMaterialDeleterService;
      const runtimeLocalScope = yield* getRuntimeLocalScopeOption();

      return createRuntimeSourceAuthService({
        executorState,
        liveExecutionManager,
        sourceStore,
        sourceCatalogSync,
        resolveSecretMaterial,
        storeSecretMaterial,
        deleteSecretMaterial,
        getLocalServerBaseUrl: input.getLocalServerBaseUrl,
        localScopeState: runtimeLocalScope ?? undefined,
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
