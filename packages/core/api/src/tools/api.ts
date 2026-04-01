import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import {
  ScopeId,
  ToolId,
  ToolNotFoundError,
  ToolInvocationError,
  PolicyDeniedError,
  ElicitationDeclinedError,
} from "@executor/sdk";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const toolIdParam = HttpApiSchema.param("toolId", ToolId);

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ToolMetadataResponse = Schema.Struct({
  id: ToolId,
  pluginKey: Schema.String,
  sourceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mayElicit: Schema.optional(Schema.Boolean),
});

const ToolSchemaResponse = Schema.Struct({
  id: ToolId,
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
});

const ToolInvokePayload = Schema.Struct({
  args: Schema.Unknown,
});

const ToolInvokeResponse = Schema.Struct({
  data: Schema.Unknown,
  error: Schema.NullOr(Schema.Unknown),
  status: Schema.optional(Schema.Number),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const ToolNotFound = ToolNotFoundError.annotations(
  HttpApiSchema.annotations({ status: 404 }),
);
const ToolInvocation = ToolInvocationError.annotations(
  HttpApiSchema.annotations({ status: 500 }),
);
const PolicyDenied = PolicyDeniedError.annotations(
  HttpApiSchema.annotations({ status: 403 }),
);
const ElicitationDeclined = ElicitationDeclinedError.annotations(
  HttpApiSchema.annotations({ status: 422 }),
);

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class ToolsApi extends HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list")`/scopes/${scopeIdParam}/tools`
      .addSuccess(Schema.Array(ToolMetadataResponse)),
  )
  .add(
    HttpApiEndpoint.get("schema")`/scopes/${scopeIdParam}/tools/${toolIdParam}/schema`
      .addSuccess(ToolSchemaResponse)
      .addError(ToolNotFound),
  )
  .add(
    HttpApiEndpoint.post("invoke")`/scopes/${scopeIdParam}/tools/${toolIdParam}/invoke`
      .setPayload(ToolInvokePayload)
      .addSuccess(ToolInvokeResponse)
      .addError(ToolNotFound)
      .addError(ToolInvocation)
      .addError(PolicyDenied)
      .addError(ElicitationDeclined),
  )
  .prefix("/v1") {}
