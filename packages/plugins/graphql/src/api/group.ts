import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";
import { InternalError } from "@executor/api";

import { GraphqlIntrospectionError, GraphqlExtractionError } from "../sdk/errors";
import { HeaderValue } from "../sdk/types";

// StoredGraphqlSource shape as an HTTP response schema. Kept local to the
// api layer because the sdk-side `StoredGraphqlSource` is a plain interface.
const StoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: HeaderValue }),
});

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
  name: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
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
//
// Plugin SDK errors (GraphqlIntrospectionError etc.) are declared once at
// the group level via `.addError(...)` — every endpoint inherits them. The
// errors themselves carry their HTTP status via `HttpApiSchema.annotations`
// above, so handlers just `return yield* ext.foo(...)` and the schema
// encodes whatever it gets.
//
// 5xx is handled at the API level: `.addError(InternalError)` adds a
// single shared opaque-by-schema 500 surface translated from `StorageError`
// by `withCapture` at the HTTP edge. No per-handler wrapping, no
// per-plugin InternalError.
// ---------------------------------------------------------------------------

export class GraphqlGroup extends HttpApiGroup.make("graphql")
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/graphql/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse),
  )
  .add(
    HttpApiEndpoint.get("getSource")`/scopes/${scopeIdParam}/graphql/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(StoredSourceSchema)),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/graphql/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // Plugin domain errors carry their own HttpApiSchema status (4xx);
  // `InternalError` is the shared opaque 500 translated at the HTTP
  // edge by `withCapture`.
  .addError(InternalError)
  .addError(IntrospectionError)
  .addError(ExtractionError) {}
