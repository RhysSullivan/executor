import * as Schema from "effect/Schema";

import {
  StoredHttpOauth2SetupSchema,
  StringMapSchema,
} from "@executor/source-core";

export const OpenApiLocalConfigBindingSchema = Schema.Struct({
  specUrl: Schema.String,
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  oauth2: Schema.optional(Schema.NullOr(StoredHttpOauth2SetupSchema)),
});
