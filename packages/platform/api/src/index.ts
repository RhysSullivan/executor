export {
  ExecutorApi,
  executorOpenApiSpec,
} from "./api";
export {
  createExecutorApiClient,
  type ExecutorApiClient,
} from "./client";

export type { LocalInstallation } from "@executor/platform-sdk/schema";

export {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "./errors";

export {
  CreateExecutionPayloadSchema,
  ExecutionsApi,
  ResumeExecutionPayloadSchema,
  type CreateExecutionPayload,
  type ResumeExecutionPayload,
} from "./executions/api";

export {
  LocalApi,
  type SecretProvider,
  type InstanceConfig,
  type SecretListItem,
  type CreateSecretPayload,
  type CreateSecretResult,
  type UpdateSecretPayload,
  type UpdateSecretResult,
  type DeleteSecretResult,
} from "./local/api";

export {
  OAuthApi,
  StartSourceOAuthPayloadSchema,
  StartSourceOAuthResultSchema,
  CompleteSourceOAuthResultSchema,
  SourceOAuthPopupFailureResultSchema,
  SourceOAuthPopupResultSchema,
  SourceOAuthPopupSuccessResultSchema,
  type StartSourceOAuthPayload,
  type StartSourceOAuthResult,
  type CompleteSourceOAuthResult,
  type SourceOAuthPopupResult,
} from "./oauth/api";

export {
  CreateWorkspaceOauthClientPayloadSchema,
  CreateSourcePayloadSchema,
  DiscoverSourcePayloadSchema,
  SourcesApi,
  UpdateSourcePayloadSchema,
  type CreateWorkspaceOauthClientPayload,
  type CreateSourcePayload,
  type DiscoverSourcePayload,
  type UpdateSourcePayload,
} from "./sources/api";

export {
  CreatePolicyPayloadSchema,
  PoliciesApi,
  UpdatePolicyPayloadSchema,
  type CreatePolicyPayload,
  type UpdatePolicyPayload,
} from "./policies/api";
