import * as Effect from "effect/Effect";

import {
  createExecutorRuntimeFromServices,
  type BoundInstallationStore,
  type BoundLocalToolRuntimeLoader,
  type BoundSourceArtifactStore,
  type BoundSourceTypeDeclarationsRefresher,
  type BoundWorkspaceConfigStore,
  type BoundWorkspaceStateStore,
  type ExecutorRuntime,
  type ExecutorRuntimeOptions,
  type RuntimeInstanceConfigService,
  type RuntimeStorageServices,
  type RuntimeSecretMaterialServices,
} from "./runtime";
import type {
  ExecutorWorkspaceContext,
  ExecutorWorkspaceDescriptor,
} from "./workspace";
export type {
  ExecutorWorkspaceContext,
  ExecutorWorkspaceDescriptor,
} from "./workspace";

export type ExecutorBackend = {
  createRuntime: (
    options: ExecutorRuntimeOptions,
  ) => Effect.Effect<ExecutorRuntime, Error>;
};

export type ExecutorInstallationBackend = BoundInstallationStore;
export type ExecutorWorkspaceConfigBackend = BoundWorkspaceConfigStore;
export type ExecutorWorkspaceStateBackend = BoundWorkspaceStateStore;
export type ExecutorSourceArtifactBackend = BoundSourceArtifactStore;
export type ExecutorStateBackend = import("./runtime").ExecutorStateStoreShape;
export type ExecutorLocalToolBackend = BoundLocalToolRuntimeLoader;
export type ExecutorSourceTypeDeclarationsBackend =
  BoundSourceTypeDeclarationsRefresher;
export type ExecutorSecretMaterialBackend = RuntimeSecretMaterialServices;
export type ExecutorInstanceConfigBackend = RuntimeInstanceConfigService;

export type ExecutorStorageBackend = {
  installation: ExecutorInstallationBackend;
  workspaceConfig: ExecutorWorkspaceConfigBackend;
  workspaceState: ExecutorWorkspaceStateBackend;
  sourceArtifacts: ExecutorSourceArtifactBackend;
  executorState: ExecutorStateBackend;
  secretMaterial: ExecutorSecretMaterialBackend;
  close?: () => Promise<void>;
};

export type ExecutorBackendServices = {
  workspace: ExecutorWorkspaceDescriptor;
  storage: ExecutorStorageBackend;
  instanceConfig: ExecutorInstanceConfigBackend;
  localTools?: ExecutorLocalToolBackend;
  sourceTypeDeclarations?: ExecutorSourceTypeDeclarationsBackend;
};

export const createExecutorBackend = (input: {
  loadServices: (
    options: ExecutorRuntimeOptions,
  ) => Effect.Effect<ExecutorBackendServices, Error>;
}): ExecutorBackend => ({
  createRuntime: (options) =>
    Effect.flatMap(input.loadServices(options), (services) =>
      createExecutorRuntimeFromServices({
        ...options,
        services: {
          workspace: services.workspace,
          storage: services.storage satisfies RuntimeStorageServices,
          localToolRuntimeLoader: services.localTools,
          sourceTypeDeclarationsRefresher: services.sourceTypeDeclarations,
          instanceConfig: services.instanceConfig,
        },
      }),
    ),
});
