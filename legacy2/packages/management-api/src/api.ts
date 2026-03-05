import { HttpApi, OpenApi } from "@effect/platform";

import { CredentialsApi } from "./credentials/api";
import { InteractionsApi } from "./interactions/api";
import { OrganizationsApi } from "./organizations/api";
import { PoliciesApi } from "./policies/api";
import { StorageApi } from "./storage/api";
import { SourcesApi } from "./sources/api";
import { ToolsApi } from "./tools/api";
import { WorkspacesApi } from "./workspaces/api";

export {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "./errors";

export {
  RemoveSourceResultSchema,
  UpsertSourcePayloadSchema,
  type RemoveSourceResult,
  type UpsertSourcePayload,
} from "./sources/api";

export {
  RemoveCredentialBindingResultSchema,
  UpsertCredentialBindingPayloadSchema,
  type RemoveCredentialBindingResult,
  type UpsertCredentialBindingPayload,
} from "./credentials/api";

export {
  RemovePolicyResultSchema,
  UpsertPolicyPayloadSchema,
  type RemovePolicyResult,
  type UpsertPolicyPayload,
} from "./policies/api";

export {
  UpsertOrganizationPayloadSchema,
  type UpsertOrganizationPayload,
} from "./organizations/api";

export {
  SourceToolDetailSchema,
  SourceToolSummarySchema,
  type SourceToolDetail,
  type SourceToolSummary,
} from "./tools/api";

export {
  UpsertWorkspacePayloadSchema,
  type UpsertWorkspacePayload,
} from "./workspaces/api";

export {
  ListStorageDirectoryPayloadSchema,
  ListStorageDirectoryResultSchema,
  ListStorageKvPayloadSchema,
  ListStorageKvResultSchema,
  OpenStorageInstancePayloadSchema,
  QueryStorageSqlPayloadSchema,
  QueryStorageSqlResultSchema,
  ReadStorageFilePayloadSchema,
  ReadStorageFileResultSchema,
  RemoveStorageInstanceResultSchema,
  type ListStorageDirectoryPayload,
  type ListStorageDirectoryResult,
  type ListStorageKvPayload,
  type ListStorageKvResult,
  type OpenStorageInstancePayload,
  type QueryStorageSqlPayload,
  type QueryStorageSqlResult,
  type ReadStorageFilePayload,
  type ReadStorageFileResult,
  type RemoveStorageInstanceResult,
} from "./storage/api";

export {
  ResolveInteractionPayloadSchema,
  type ResolveInteractionPayload,
} from "./interactions/api";

export class ControlPlaneApi extends HttpApi.make("controlPlane")
  .add(SourcesApi)
  .add(CredentialsApi)
  .add(PoliciesApi)
  .add(OrganizationsApi)
  .add(WorkspacesApi)
  .add(ToolsApi)
  .add(StorageApi)
  .add(InteractionsApi)
  .annotateContext(
    OpenApi.annotations({
      title: "Executor v2 Management API",
      description: "Backend-agnostic management API",
    }),
  ) {}

export const controlPlaneOpenApiSpec = OpenApi.fromApi(ControlPlaneApi);
