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
  type RuntimeExecutionStorageServices,
  type RuntimeInstanceConfigService,
  type RuntimeSecretsStorageServices,
  type RuntimeStorageServices,
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

export type ExecutorInstallationRepository = PublicizeObject<BoundInstallationStore>;
export type ExecutorWorkspaceConfigRepository = PublicizeObject<BoundScopeConfigStore>;
export type ExecutorWorkspaceStateRepository = PublicizeObject<BoundScopeStateStore>;
export type ExecutorWorkspaceSourceArtifactRepository = PublicizeObject<
  BoundSourceArtifactStore
>;
export type ExecutorWorkspaceLocalToolRepository = PublicizeObject<
  BoundLocalToolRuntimeLoader
>;
export type ExecutorWorkspaceSourceTypeDeclarationsRepository = PublicizeObject<
  BoundSourceTypeDeclarationsRefresher
>;
export type ExecutorSecretRepository = PublicizeObject<RuntimeSecretsStorageServices>;
export type ExecutorExecutionRepository = {
  runs: PublicizeObject<RuntimeExecutionStorageServices["runs"]>;
  interactions: PublicizeObject<RuntimeExecutionStorageServices["interactions"]>;
  steps: PublicizeObject<RuntimeExecutionStorageServices["steps"]>;
};
export type ExecutorInstanceConfigRepository = PublicizeObject<
  RuntimeInstanceConfigService
>;

export type ExecutorWorkspaceRepository = {
  config: ExecutorWorkspaceConfigRepository;
  state: ExecutorWorkspaceStateRepository;
  sourceArtifacts: ExecutorWorkspaceSourceArtifactRepository;
  localTools?: ExecutorWorkspaceLocalToolRepository;
  sourceTypeDeclarations?: ExecutorWorkspaceSourceTypeDeclarationsRepository;
};

export type ExecutorBackendRepositories = {
  scope: ExecutorScopeDescriptor;
  installation: ExecutorInstallationRepository;
  workspace: ExecutorWorkspaceRepository;
  secrets: ExecutorSecretRepository;
  executions: ExecutorExecutionRepository;
  instanceConfig: ExecutorInstanceConfigRepository;
  close?: () => Promise<void>;
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
  input: ExecutorInstallationRepository,
): BoundInstallationStore => ({
  load: () => toEffect(input.load()),
  getOrProvision: () => toEffect(input.getOrProvision()),
});

const toScopeConfigBackend = (
  input: ExecutorWorkspaceConfigRepository,
): BoundScopeConfigStore => ({
  load: () => toEffect(input.load()),
  writeProject: (config) => toEffect(input.writeProject(config)),
  resolveRelativePath: input.resolveRelativePath,
});

const toScopeStateBackend = (
  input: ExecutorWorkspaceStateRepository,
): BoundScopeStateStore => ({
  load: () => toEffect(input.load()),
  write: (state) => toEffect(input.write(state)),
});

const toSourceArtifactBackend = (
  input: ExecutorWorkspaceSourceArtifactRepository,
): BoundSourceArtifactStore => ({
  build: input.build,
  read: (sourceId) => toEffect(input.read(sourceId)),
  write: (payload) => toEffect(input.write(payload)),
  remove: (sourceId) => toEffect(input.remove(sourceId)),
});

const toInstanceConfigBackend = (
  input: ExecutorInstanceConfigRepository,
): RuntimeInstanceConfigService => ({
  resolve: () => toEffect(input.resolve()),
});

const toLocalToolBackend = (
  input: ExecutorWorkspaceLocalToolRepository,
): BoundLocalToolRuntimeLoader => ({
  load: () => toEffect(input.load()),
});

const toSourceTypeDeclarationsBackend = (
  input: ExecutorWorkspaceSourceTypeDeclarationsRepository,
): BoundSourceTypeDeclarationsRefresher => ({
  refreshWorkspaceInBackground: (payload) =>
    toEffect(input.refreshWorkspaceInBackground(payload)).pipe(Effect.orDie),
  refreshSourceInBackground: (payload) =>
    toEffect(input.refreshSourceInBackground(payload)).pipe(Effect.orDie),
});

const toSecretsBackend = (
  input: ExecutorSecretRepository,
): RuntimeSecretsStorageServices => ({
  secretStores: {
    getById: (id) => toOptionEffect(input.secretStores.getById(id)),
    listAll: () => toEffect(input.secretStores.listAll()),
    upsert: (store) => toEffect(input.secretStores.upsert(store)),
    updateById: (id, patch) =>
      toOptionEffect(input.secretStores.updateById(id, patch)),
    removeById: (id) => toEffect(input.secretStores.removeById(id)),
  },
  secretMaterialStoredData: {
    getBySecretId: (secretId) =>
      toOptionEffect(input.secretMaterialStoredData.getBySecretId(secretId)),
    upsert: (record) => toEffect(input.secretMaterialStoredData.upsert(record)),
    removeBySecretId: (secretId) =>
      toEffect(input.secretMaterialStoredData.removeBySecretId(secretId)),
  },
  getById: (id) => toOptionEffect(input.getById(id)),
  listAll: () => toEffect(input.listAll()),
  upsert: (material) => toEffect(input.upsert(material)),
  updateById: (id, patch) => toOptionEffect(input.updateById(id, patch)),
  removeById: (id) => toEffect(input.removeById(id)),
  resolve: (payload) => toEffect(input.resolve(payload)),
  store: (payload) => toEffect(input.store(payload)),
  delete: (payload) => toEffect(input.delete(payload)),
  update: (payload) => toEffect(input.update(payload)),
});

const toExecutionsBackend = (
  input: ExecutorExecutionRepository,
): RuntimeExecutionStorageServices => ({
  runs: {
    listByScope: (scopeId) => toEffect(input.runs.listByScope(scopeId)),
    getById: (executionId) => toOptionEffect(input.runs.getById(executionId)),
    getByScopeAndId: (scopeId, executionId) =>
      toOptionEffect(input.runs.getByScopeAndId(scopeId, executionId)),
    insert: (execution) => toEffect(input.runs.insert(execution)),
    update: (executionId, patch) =>
      toOptionEffect(input.runs.update(executionId, patch)),
  },
  interactions: {
    getById: (interactionId) =>
      toOptionEffect(input.interactions.getById(interactionId)),
    listByExecutionId: (executionId) =>
      toEffect(input.interactions.listByExecutionId(executionId)),
    getPendingByExecutionId: (executionId) =>
      toOptionEffect(input.interactions.getPendingByExecutionId(executionId)),
    insert: (interaction) => toEffect(input.interactions.insert(interaction)),
    update: (interactionId, patch) =>
      toOptionEffect(input.interactions.update(interactionId, patch)),
  },
  steps: {
    getByExecutionAndSequence: (executionId, sequence) =>
      toOptionEffect(input.steps.getByExecutionAndSequence(executionId, sequence)),
    listByExecutionId: (executionId) =>
      toEffect(input.steps.listByExecutionId(executionId)),
    insert: (step) => toEffect(input.steps.insert(step)),
    deleteByExecutionId: (executionId) =>
      toEffect(input.steps.deleteByExecutionId(executionId)),
    updateByExecutionAndSequence: (executionId, sequence, patch) =>
      toOptionEffect(
        input.steps.updateByExecutionAndSequence(
          executionId,
          sequence,
          patch,
        ),
      ),
  },
});

export const createExecutorBackend = (input: {
  loadRepositories: (
    options: ExecutorRuntimeOptions,
  ) => MaybeEffect<ExecutorBackendRepositories>;
}): ExecutorBackend => ({
  createRuntime: (options) =>
    Effect.flatMap(toEffect(input.loadRepositories(options)), (repositories) =>
      createExecutorRuntimeFromServices({
        ...options,
        services: {
          scope: repositories.scope,
          storage: {
            installation: toInstallationBackend(repositories.installation),
            scopeConfig: toScopeConfigBackend(repositories.workspace.config),
            scopeState: toScopeStateBackend(repositories.workspace.state),
            sourceArtifacts: toSourceArtifactBackend(
              repositories.workspace.sourceArtifacts,
            ),
            secrets: toSecretsBackend(repositories.secrets),
            executions: toExecutionsBackend(repositories.executions),
            close: repositories.close,
          } satisfies RuntimeStorageServices,
          localToolRuntimeLoader: repositories.workspace.localTools
            ? toLocalToolBackend(repositories.workspace.localTools)
            : undefined,
          sourceTypeDeclarationsRefresher: repositories.workspace.sourceTypeDeclarations
            ? toSourceTypeDeclarationsBackend(
              repositories.workspace.sourceTypeDeclarations,
            )
            : undefined,
          instanceConfig: toInstanceConfigBackend(repositories.instanceConfig),
        },
      }),
    ),
});
