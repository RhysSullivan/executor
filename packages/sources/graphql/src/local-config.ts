import * as Schema from "effect/Schema";

import {
  StoredHttpOauth2SetupSchema,
  StringMapSchema,
} from "@executor/source-core";

export const GraphqlLocalConfigBindingSchema = Schema.Struct({
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  oauth2: Schema.optional(Schema.NullOr(StoredHttpOauth2SetupSchema)),
});
