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
  CreateSecretPayload,
  CreateSecretResult,
  DeleteSecretResult,
  InstanceConfig,
  LocalInstallation,
  SecretListItem,
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
  useExecutorMutation,
} from "./hooks/mutations";
export {
  useInstanceConfig,
  useLocalInstallation,
  useRefreshLocalInstallation,
} from "./hooks/local";
export {
  useCreateSecret,
  useDeleteSecret,
  useRefreshSecrets,
  useSecrets,
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
