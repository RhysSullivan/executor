import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

import { GraphqlIntrospectionError, GraphqlExtractionError } from "../sdk/errors";
import { StoredSourceSchema } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSourcePayload = Schema.Struct({
  endpoint: Schema.String,
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const UpdateSourcePayload = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// Errors with HTTP status
// ---------------------------------------------------------------------------

const IntrospectionError = GraphqlIntrospectionError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);
const ExtractionError = GraphqlExtractionError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class GraphqlGroup extends HttpApiGroup.make("graphql")
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/graphql/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse)
      .addError(IntrospectionError)
      .addError(ExtractionError),
  )
  .add(
    HttpApiEndpoint.get(
      "getSource",
    )`/scopes/${scopeIdParam}/graphql/sources/${namespaceParam}`.addSuccess(
      Schema.NullOr(StoredSourceSchema),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/graphql/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  ) {}
