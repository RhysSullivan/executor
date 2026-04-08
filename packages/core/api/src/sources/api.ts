import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId, ToolId } from "@executor/sdk";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const sourceIdParam = HttpApiSchema.param("sourceId", Schema.String);

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const SourceResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  runtime: Schema.optional(Schema.Boolean),
  canRemove: Schema.optional(Schema.Boolean),
  canRefresh: Schema.optional(Schema.Boolean),
});

const SourceRemoveResponse = Schema.Struct({
  removed: Schema.Boolean,
});

const SourceRefreshResponse = Schema.Struct({
  refreshed: Schema.Boolean,
});

const ToolMetadataResponse = Schema.Struct({
  id: ToolId,
  pluginKey: Schema.String,
  sourceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mayElicit: Schema.optional(Schema.Boolean),
});

const DetectRequest = Schema.Struct({
  url: Schema.String,
});

const DetectResultResponse = Schema.Struct({
  kind: Schema.String,
  confidence: Schema.Literal("high", "medium", "low"),
  endpoint: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class SourcesApi extends HttpApiGroup.make("sources")
  .add(
    HttpApiEndpoint.get("list")`/scopes/${scopeIdParam}/sources`
      .addSuccess(Schema.Array(SourceResponse)),
  )
  .add(
    HttpApiEndpoint.del("remove")`/scopes/${scopeIdParam}/sources/${sourceIdParam}`
      .addSuccess(SourceRemoveResponse),
  )
  .add(
    HttpApiEndpoint.post("refresh")`/scopes/${scopeIdParam}/sources/${sourceIdParam}/refresh`
      .addSuccess(SourceRefreshResponse),
  )
  .add(
    HttpApiEndpoint.get("tools")`/scopes/${scopeIdParam}/sources/${sourceIdParam}/tools`
      .addSuccess(Schema.Array(ToolMetadataResponse)),
  )
  .add(
    HttpApiEndpoint.post("detect")`/scopes/${scopeIdParam}/sources/detect`
      .setPayload(DetectRequest)
      .addSuccess(Schema.Array(DetectResultResponse)),
  )
  {}
