import { Schema } from "effect";

import { HeaderValue } from "./types";

// ---------------------------------------------------------------------------
// Stored source — the shape persisted by the operation store and exposed
// via the getSource HTTP endpoint.
// ---------------------------------------------------------------------------

export class StoredSourceSchema extends Schema.Class<StoredSourceSchema>(
  "OpenApiStoredSource",
)({
  namespace: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    spec: Schema.String,
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(
      Schema.Record({ key: Schema.String, value: HeaderValue }),
    ),
  }),
}) {}

export type StoredSourceSchemaType = typeof StoredSourceSchema.Type;
