import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  ConnectSourceBatchPayloadSchema,
  ConnectSourceBatchResultSchema,
  ConnectSourcePayloadSchema,
  ConnectSourceResultSchema,
  CreateSourcePayloadSchema,
  CreateScopeOauthClientPayloadSchema as CreateWorkspaceOauthClientPayloadSchema,
  CredentialOauthCompleteUrlParamsSchema,
  CredentialPageUrlParamsSchema,
  CredentialSubmitPayloadSchema,
  DiscoverSourcePayloadSchema,
  UpdateSourcePayloadSchema,
  ScopeOauthClientQuerySchema as WorkspaceOauthClientQuerySchema,
} from "@executor/platform-sdk/contracts";
import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "@executor/platform-sdk/errors";
import {
  ProviderAuthGrantIdSchema,
  SourceDiscoveryResultSchema,
  SourceIdSchema,
  SourceInspectionDiscoverPayloadSchema,
  SourceInspectionDiscoverResultSchema,
  SourceInspectionSchema,
  SourceInspectionToolDetailSchema,
  SourceSchema,
  ScopeOauthClientIdSchema as WorkspaceOauthClientIdSchema,
  ScopeOauthClientSchema as WorkspaceOauthClientSchema,
  ScopeIdSchema as WorkspaceIdSchema,
} from "@executor/platform-sdk/schema";
import * as Schema from "effect/Schema";

export type {
  ConnectSourceBatchPayload,
  ConnectSourceBatchResult,
  ConnectSourcePayload,
  ConnectSourceResult,
  CreateSourcePayload,
  CreateScopeOauthClientPayload as CreateWorkspaceOauthClientPayload,
  DiscoverSourcePayload,
  UpdateSourcePayload,
} from "@executor/platform-sdk/contracts";

export {
  ConnectSourceBatchPayloadSchema,
  ConnectSourceBatchResultSchema,
  ConnectSourcePayloadSchema,
  ConnectSourceResultSchema,
  CreateSourcePayloadSchema,
  CreateWorkspaceOauthClientPayloadSchema,
  DiscoverSourcePayloadSchema,
  UpdateSourcePayloadSchema,
};

export const SourceOauthClientStateSchema = Schema.NullOr(
  Schema.Struct({
    clientId: Schema.String,
    hasClientSecret: Schema.Boolean,
    redirectMode: Schema.Literal("app_callback", "loopback"),
  }),
);

export type SourceOauthClientState = typeof SourceOauthClientStateSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);
const toolPathParam = HttpApiSchema.param("toolPath", Schema.String);
const oauthClientIdParam = HttpApiSchema.param(
  "oauthClientId",
  WorkspaceOauthClientIdSchema,
);
const grantIdParam = HttpApiSchema.param("grantId", ProviderAuthGrantIdSchema);

const HtmlSchema = HttpApiSchema.Text({
  contentType: "text/html",
});

export class SourcesApi extends HttpApiGroup.make("sources")
  .add(
    HttpApiEndpoint.post("discover")`/sources/discover`
      .setPayload(DiscoverSourcePayloadSchema)
      .addSuccess(SourceDiscoveryResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError),
  )
  .add(
    HttpApiEndpoint.post("connect")`/workspaces/${workspaceIdParam}/sources/connect`
      .setPayload(ConnectSourcePayloadSchema)
      .addSuccess(ConnectSourceResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("connectBatch")`/workspaces/${workspaceIdParam}/sources/connect-batch`
      .setPayload(ConnectSourceBatchPayloadSchema)
      .addSuccess(ConnectSourceBatchResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaceOauthClients")`/workspaces/${workspaceIdParam}/oauth-clients`
      .setUrlParams(WorkspaceOauthClientQuerySchema)
      .addSuccess(Schema.Array(WorkspaceOauthClientSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("createWorkspaceOauthClient")`/workspaces/${workspaceIdParam}/oauth-clients`
      .setPayload(CreateWorkspaceOauthClientPayloadSchema)
      .addSuccess(WorkspaceOauthClientSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeWorkspaceOauthClient")`/workspaces/${workspaceIdParam}/oauth-clients/${oauthClientIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeProviderAuthGrant")`/workspaces/${workspaceIdParam}/provider-grants/${grantIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/sources`
      .addSuccess(Schema.Array(SourceSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/workspaces/${workspaceIdParam}/sources`
      .setPayload(CreateSourcePayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("getSourceOauthClient")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/oauth-client`
      .addSuccess(SourceOauthClientStateSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .setPayload(UpdateSourcePayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("credentialPage")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/credentials`
      .setUrlParams(CredentialPageUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("credentialSubmit")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/credentials`
      .setUrlParams(CredentialPageUrlParamsSchema)
      .setPayload(CredentialSubmitPayloadSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("credentialComplete")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/credentials/oauth/complete`
      .setUrlParams(CredentialOauthCompleteUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("providerOauthComplete")`/workspaces/${workspaceIdParam}/oauth/provider/callback`
      .setUrlParams(CredentialOauthCompleteUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("inspection")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/inspection`
      .addSuccess(SourceInspectionSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("inspectionTool")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/tools/${toolPathParam}/inspection`
      .addSuccess(SourceInspectionToolDetailSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("inspectionDiscover")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/inspection/discover`
      .setPayload(SourceInspectionDiscoverPayloadSchema)
      .addSuccess(SourceInspectionDiscoverResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
