import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import {
  ScopeId,
  ToolId,
  ToolNotFoundError,
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
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const ToolNotFound = ToolNotFoundError.annotations(
  HttpApiSchema.annotations({ status: 404 }),
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
  {}
