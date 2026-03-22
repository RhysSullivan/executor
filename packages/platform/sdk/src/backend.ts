import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createExecutorRuntimeFromServices,
  type BoundInstallationStore,
  type BoundLocalToolRuntimeLoader,
  type BoundSourceArtifactStore,
  type BoundSourceTypeDeclarationsRefresher,
  type BoundScopeConfigStore,
  type BoundScopeStateStore,
  type ExecutorRuntime,
  type ExecutorRuntimeOptions,
  type RuntimeInstanceConfigService,
  type RuntimeStorageServices,
  type RuntimeSecretMaterialServices,
} from "./runtime";
import type {
  ExecutorScopeContext,
  ExecutorScopeDescriptor,
} from "./scope";
export type {
  ExecutorScopeContext,
  ExecutorScopeDescriptor,
} from "./scope";

export type ExecutorBackend = {
  createRuntime: (
    options: ExecutorRuntimeOptions,
  ) => Effect.Effect<ExecutorRuntime, Error>;
};

type MaybeEffect<T> = T | Promise<T> | Effect.Effect<T, Error, never>;
type OptionalValue<T> = T | null | Option.Option<T>;
type PublicizeMethod<F> = F extends (...args: infer Args) => Effect.Effect<infer Value, any, any>
  ? [Value] extends [Option.Option<infer Inner>]
    ? (...args: Args) => MaybeEffect<OptionalValue<Inner>>
    : (...args: Args) => MaybeEffect<Value>
  : F;
type PublicizeObject<T> = {
  [Key in keyof T]: T[Key] extends (...args: any[]) => any
    ? PublicizeMethod<T[Key]>
    : T[Key] extends object
      ? PublicizeObject<T[Key]>
      : T[Key];
};

export type ExecutorInstallationBackend = PublicizeObject<BoundInstallationStore>;
export type ExecutorScopeConfigBackend = PublicizeObject<BoundScopeConfigStore>;
export type ExecutorScopeStateBackend = PublicizeObject<BoundScopeStateStore>;
export type ExecutorSourceArtifactBackend = PublicizeObject<BoundSourceArtifactStore>;
export type ExecutorStateBackend = PublicizeObject<import("./runtime").ExecutorStateStoreShape>;
export type ExecutorLocalToolBackend = PublicizeObject<BoundLocalToolRuntimeLoader>;
export type ExecutorSourceTypeDeclarationsBackend = PublicizeObject<
  BoundSourceTypeDeclarationsRefresher
>;
export type ExecutorSecretMaterialBackend = PublicizeObject<RuntimeSecretMaterialServices>;
export type ExecutorInstanceConfigBackend = PublicizeObject<RuntimeInstanceConfigService>;

export type ExecutorStorageBackend = {
  installation: ExecutorInstallationBackend;
  scopeConfig: ExecutorScopeConfigBackend;
  scopeState: ExecutorScopeStateBackend;
  sourceArtifacts: ExecutorSourceArtifactBackend;
  executorState: ExecutorStateBackend;
  secretMaterial: ExecutorSecretMaterialBackend;
  close?: () => Promise<void>;
};

export type ExecutorBackendServices = {
  scope: ExecutorScopeDescriptor;
  storage: ExecutorStorageBackend;
  instanceConfig: ExecutorInstanceConfigBackend;
  localTools?: ExecutorLocalToolBackend;
  sourceTypeDeclarations?: ExecutorSourceTypeDeclarationsBackend;
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const toEffect = <T>(value: MaybeEffect<T>): Effect.Effect<T, Error, never> => {
  if (Effect.isEffect(value)) {
    return value;
  }

  if (value instanceof Promise) {
    return Effect.tryPromise({
      try: () => value,
      catch: toError,
    });
  }

  return Effect.succeed(value);
};

const toOptionEffect = <T>(
  value: MaybeEffect<OptionalValue<T>>,
): Effect.Effect<Option.Option<T>, Error, never> =>
  toEffect(value).pipe(
    Effect.map((result) =>
      Option.isOption(result) ? result : Option.fromNullable(result),
    ),
  );

const toInstallationBackend = (
  input: ExecutorInstallationBackend,
): BoundInstallationStore => ({
  load: () => toEffect(input.load()),
  getOrProvision: () => toEffect(input.getOrProvision()),
});

const toScopeConfigBackend = (
  input: ExecutorScopeConfigBackend,
): BoundScopeConfigStore => ({
  load: () => toEffect(input.load()),
  writeProject: (config) => toEffect(input.writeProject(config)),
  resolveRelativePath: input.resolveRelativePath,
});

const toScopeStateBackend = (
  input: ExecutorScopeStateBackend,
): BoundScopeStateStore => ({
  load: () => toEffect(input.load()),
  write: (state) => toEffect(input.write(state)),
});

const toSourceArtifactBackend = (
  input: ExecutorSourceArtifactBackend,
): BoundSourceArtifactStore => ({
  build: input.build,
  read: (sourceId) => toEffect(input.read(sourceId)),
  write: (payload) => toEffect(input.write(payload)),
  remove: (sourceId) => toEffect(input.remove(sourceId)),
});

const toSecretMaterialBackend = (
  input: ExecutorSecretMaterialBackend,
): RuntimeSecretMaterialServices => ({
  resolve: (payload) => toEffect(input.resolve(payload)),
  store: (payload) => toEffect(input.store(payload)),
  delete: (payload) => toEffect(input.delete(payload)),
  update: (payload) => toEffect(input.update(payload)),
});

const toInstanceConfigBackend = (
  input: ExecutorInstanceConfigBackend,
): RuntimeInstanceConfigService => ({
  resolve: () => toEffect(input.resolve()),
});

const toLocalToolBackend = (
  input: ExecutorLocalToolBackend,
): BoundLocalToolRuntimeLoader => ({
  load: () => toEffect(input.load()),
});

const toSourceTypeDeclarationsBackend = (
  input: ExecutorSourceTypeDeclarationsBackend,
): BoundSourceTypeDeclarationsRefresher => ({
  refreshWorkspaceInBackground: (payload) =>
    toEffect(input.refreshWorkspaceInBackground(payload)).pipe(Effect.orDie),
  refreshSourceInBackground: (payload) =>
    toEffect(input.refreshSourceInBackground(payload)).pipe(Effect.orDie),
});

const toExecutorStateBackend = (
  input: ExecutorStateBackend,
): import("./runtime").ExecutorStateStoreShape => ({
  authArtifacts: {
    listByScopeId: (scopeId) => toEffect(input.authArtifacts.listByScopeId(scopeId)),
    listByScopeAndSourceId: (payload) =>
      toEffect(input.authArtifacts.listByScopeAndSourceId(payload)),
    getByScopeSourceAndActor: (payload) =>
      toOptionEffect(input.authArtifacts.getByScopeSourceAndActor(payload)),
    upsert: (artifact) => toEffect(input.authArtifacts.upsert(artifact)),
    removeByScopeSourceAndActor: (payload) =>
      toEffect(input.authArtifacts.removeByScopeSourceAndActor(payload)),
    removeByScopeAndSourceId: (payload) =>
      toEffect(input.authArtifacts.removeByScopeAndSourceId(payload)),
  },
  authLeases: {
    listAll: () => toEffect(input.authLeases.listAll()),
    getByAuthArtifactId: (authArtifactId) =>
      toOptionEffect(input.authLeases.getByAuthArtifactId(authArtifactId)),
    upsert: (lease) => toEffect(input.authLeases.upsert(lease)),
    removeByAuthArtifactId: (authArtifactId) =>
      toEffect(input.authLeases.removeByAuthArtifactId(authArtifactId)),
  },
  sourceOauthClients: {
    getByScopeSourceAndProvider: (payload) =>
      toOptionEffect(input.sourceOauthClients.getByScopeSourceAndProvider(payload)),
    upsert: (oauthClient) => toEffect(input.sourceOauthClients.upsert(oauthClient)),
    removeByScopeAndSourceId: (payload) =>
      toEffect(input.sourceOauthClients.removeByScopeAndSourceId(payload)),
  },
  scopeOauthClients: {
    listByScopeAndProvider: (payload) =>
      toEffect(input.scopeOauthClients.listByScopeAndProvider(payload)),
    getById: (id) => toOptionEffect(input.scopeOauthClients.getById(id)),
    upsert: (oauthClient) => toEffect(input.scopeOauthClients.upsert(oauthClient)),
    removeById: (id) => toEffect(input.scopeOauthClients.removeById(id)),
  },
  providerAuthGrants: {
    listByScopeId: (scopeId) =>
      toEffect(input.providerAuthGrants.listByScopeId(scopeId)),
    listByScopeActorAndProvider: (payload) =>
      toEffect(input.providerAuthGrants.listByScopeActorAndProvider(payload)),
    getById: (id) => toOptionEffect(input.providerAuthGrants.getById(id)),
    upsert: (grant) => toEffect(input.providerAuthGrants.upsert(grant)),
    removeById: (id) => toEffect(input.providerAuthGrants.removeById(id)),
  },
  sourceAuthSessions: {
    listAll: () => toEffect(input.sourceAuthSessions.listAll()),
    listByScopeId: (scopeId) => toEffect(input.sourceAuthSessions.listByScopeId(scopeId)),
    getById: (id) => toOptionEffect(input.sourceAuthSessions.getById(id)),
    getByState: (state) => toOptionEffect(input.sourceAuthSessions.getByState(state)),
    getPendingByScopeSourceAndActor: (payload) =>
      toOptionEffect(input.sourceAuthSessions.getPendingByScopeSourceAndActor(payload)),
    insert: (session) => toEffect(input.sourceAuthSessions.insert(session)),
    update: (id, patch) => toOptionEffect(input.sourceAuthSessions.update(id, patch)),
    upsert: (session) => toEffect(input.sourceAuthSessions.upsert(session)),
    removeByScopeAndSourceId: (scopeId, sourceId) =>
      toEffect(input.sourceAuthSessions.removeByScopeAndSourceId(scopeId, sourceId)),
  },
  secretMaterials: {
    getById: (id) => toOptionEffect(input.secretMaterials.getById(id)),
    listAll: () => toEffect(input.secretMaterials.listAll()),
    upsert: (material) => toEffect(input.secretMaterials.upsert(material)),
    updateById: (id, patch) => toOptionEffect(input.secretMaterials.updateById(id, patch)),
    removeById: (id) => toEffect(input.secretMaterials.removeById(id)),
  },
  executions: {
    getById: (executionId) => toOptionEffect(input.executions.getById(executionId)),
    getByScopeAndId: (scopeId, executionId) =>
      toOptionEffect(input.executions.getByScopeAndId(scopeId, executionId)),
    insert: (execution) => toEffect(input.executions.insert(execution)),
    update: (executionId, patch) =>
      toOptionEffect(input.executions.update(executionId, patch)),
  },
  executionInteractions: {
    getById: (interactionId) =>
      toOptionEffect(input.executionInteractions.getById(interactionId)),
    listByExecutionId: (executionId) =>
      toEffect(input.executionInteractions.listByExecutionId(executionId)),
    getPendingByExecutionId: (executionId) =>
      toOptionEffect(input.executionInteractions.getPendingByExecutionId(executionId)),
    insert: (interaction) => toEffect(input.executionInteractions.insert(interaction)),
    update: (interactionId, patch) =>
      toOptionEffect(input.executionInteractions.update(interactionId, patch)),
  },
  executionSteps: {
    getByExecutionAndSequence: (executionId, sequence) =>
      toOptionEffect(input.executionSteps.getByExecutionAndSequence(executionId, sequence)),
    listByExecutionId: (executionId) =>
      toEffect(input.executionSteps.listByExecutionId(executionId)),
    insert: (step) => toEffect(input.executionSteps.insert(step)),
    deleteByExecutionId: (executionId) =>
      toEffect(input.executionSteps.deleteByExecutionId(executionId)),
    updateByExecutionAndSequence: (executionId, sequence, patch) =>
      toOptionEffect(
        input.executionSteps.updateByExecutionAndSequence(
          executionId,
          sequence,
          patch,
        ),
      ),
  },
});

export const createExecutorBackend = (input: {
  loadServices: (
    options: ExecutorRuntimeOptions,
  ) => MaybeEffect<ExecutorBackendServices>;
}): ExecutorBackend => ({
  createRuntime: (options) =>
    Effect.flatMap(toEffect(input.loadServices(options)), (services) =>
      createExecutorRuntimeFromServices({
        ...options,
        services: {
          scope: services.scope,
          storage: {
            installation: toInstallationBackend(services.storage.installation),
            scopeConfig: toScopeConfigBackend(services.storage.scopeConfig),
            scopeState: toScopeStateBackend(services.storage.scopeState),
            sourceArtifacts: toSourceArtifactBackend(services.storage.sourceArtifacts),
            executorState: toExecutorStateBackend(services.storage.executorState),
            secretMaterial: toSecretMaterialBackend(services.storage.secretMaterial),
            close: services.storage.close,
          } satisfies RuntimeStorageServices,
          localToolRuntimeLoader: services.localTools
            ? toLocalToolBackend(services.localTools)
            : undefined,
          sourceTypeDeclarationsRefresher: services.sourceTypeDeclarations
            ? toSourceTypeDeclarationsBackend(services.sourceTypeDeclarations)
            : undefined,
          instanceConfig: toInstanceConfigBackend(services.instanceConfig),
        },
      }),
    ),
});
