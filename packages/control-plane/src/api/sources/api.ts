import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  ExecutionInteractionIdSchema,
  JsonObjectSchema,
  SourceAuthSchema,
  SourceAuthSessionIdSchema,
  SourceDiscoveryResultSchema,
  SourceIdSchema,
  SourceInspectionDiscoverPayloadSchema,
  SourceInspectionDiscoverResultSchema,
  SourceInspectionSchemaBundleSchema,
  SourceInspectionSchema,
  SourceInspectionToolDetailSchema,
  SourceImportAuthPolicySchema,
  SourceKindSchema,
  SourceProbeAuthSchema,
  SourceSchema,
  SourceStatusSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";
import {
  OptionalTrimmedNonEmptyStringSchema,
  TrimmedNonEmptyStringSchema,
} from "../string-schemas";
import {
  ConnectSourcePayloadSchema,
  type ConnectSourcePayload,
} from "../../runtime/source-adapters";

const createSourcePayloadRequiredSchema = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  kind: SourceKindSchema,
  endpoint: TrimmedNonEmptyStringSchema,
});

const createSourcePayloadOptionalSchema = Schema.Struct({
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CreateSourcePayloadSchema = Schema.extend(
  createSourcePayloadRequiredSchema,
  createSourcePayloadOptionalSchema,
);

export type CreateSourcePayload = typeof CreateSourcePayloadSchema.Type;

export const UpdateSourcePayloadSchema = Schema.Struct({
  name: OptionalTrimmedNonEmptyStringSchema,
  endpoint: OptionalTrimmedNonEmptyStringSchema,
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export type UpdateSourcePayload = typeof UpdateSourcePayloadSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);
const toolPathParam = HttpApiSchema.param("toolPath", Schema.String);
const schemaBundleIdParam = HttpApiSchema.param("schemaBundleId", Schema.String);

const CredentialPageUrlParamsSchema = Schema.Struct({
  interactionId: ExecutionInteractionIdSchema,
});

const CredentialSubmitPayloadSchema = Schema.Struct({
  action: Schema.optional(Schema.Literal("submit", "continue", "cancel")),
  token: Schema.optional(Schema.String),
});

const CredentialOauthCompleteUrlParamsSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const DiscoverSourcePayloadSchema = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  probeAuth: Schema.optional(SourceProbeAuthSchema),
});

export type DiscoverSourcePayload = typeof DiscoverSourcePayloadSchema.Type;

const ConnectSourceResultSchema = Schema.Union(
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

export type ConnectSourceResult = typeof ConnectSourceResultSchema.Type;

export {
  ConnectSourcePayloadSchema,
  ConnectSourceResultSchema,
  DiscoverSourcePayloadSchema,
};

export type { ConnectSourcePayload };

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
    HttpApiEndpoint.get("inspectionSchemaBundle")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/inspection/schema-bundles/${schemaBundleIdParam}`
      .addSuccess(SourceInspectionSchemaBundleSchema)
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
