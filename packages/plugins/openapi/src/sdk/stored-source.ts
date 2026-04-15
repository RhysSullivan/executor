import { Schema } from "effect";

import { HeaderValue, InvocationConfig, OAuth2Auth } from "./types";

// ---------------------------------------------------------------------------
// Stored source — the shape persisted by the operation store and exposed
// via the getSource HTTP endpoint.
// ---------------------------------------------------------------------------

export class StoredSourceSchema extends Schema.Class<StoredSourceSchema>("OpenApiStoredSource")({
  namespace: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    spec: Schema.String,
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record({ key: Schema.String, value: HeaderValue })),
    /** OAuth2 auth — present only when the source was onboarded via OAuth. */
    oauth2: Schema.optional(OAuth2Auth),
  }),
  // TODO(migration): make required once all rows have been migrated to
  // carry invocationConfig. Left optional for decode compat with rows
  // written before the source-level invocationConfig refactor.
  invocationConfig: Schema.optional(InvocationConfig),
}) {}

export type StoredSourceSchemaType = typeof StoredSourceSchema.Type;
