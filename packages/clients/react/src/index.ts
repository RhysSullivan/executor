export {
  Atom,
  AtomHttpApi,
  RegistryContext,
  RegistryProvider,
  Result,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect-atom/atom-react";

export type {
  BrowseSecretStoreResult,
  CreateSecretStorePayload,
  CreateSecretPayload,
  CreateSecretResult,
  DeleteSecretStoreResult,
  DeleteSecretResult,
  InstanceConfig,
  LocalInstallation,
  SecretListItem,
  SecretStore,
  UpdateSecretStorePayload,
  UpdateSecretPayload,
  UpdateSecretResult,
} from "@executor/platform-api";

export type {
  Execution,
  ExecutionEnvelope,
  ExecutionStatus,
  Source,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
} from "@executor/platform-sdk/schema";

export {
  defineExecutorHttpApiClient,
  defineExecutorPluginHttpApiClient,
} from "./core/http-client";
export {
  getExecutorApiBaseUrl,
  setExecutorApiBaseUrl,
} from "./core/base-url";
export type {
  Loadable,
  SourceRemoveResult,
} from "./core/types";
export {
  pendingLoadable,
  useWorkspaceId,
  useWorkspaceRequestContext,
  type WorkspaceContext,
} from "./core/workspace";
export {
  ExecutorReactProvider,
} from "./provider";
export {
  SecretReferenceField,
} from "./components/secret-reference-field";
export {
  useExecutorMutation,
} from "./hooks/mutations";
export {
  useInstanceConfig,
  useLocalInstallation,
  useRefreshLocalInstallation,
} from "./hooks/local";
export {
  useCreateSecretStore,
  useCreateSecret,
  useDeleteSecretStore,
  useDeleteSecret,
  useRefreshSecretStores,
  useRefreshSecrets,
  useSecretStores,
  useSecrets,
  useUpdateSecretStore,
  useUpdateSecret,
} from "./hooks/secrets";
export {
  useExecution,
  useExecutions,
} from "./hooks/executions";
export {
  usePrefetchToolDetail,
  useRemoveSource,
  useSource,
  useSourceDiscovery,
  useSourceInspection,
  useSourceToolDetail,
  useSources,
} from "./hooks/sources";
