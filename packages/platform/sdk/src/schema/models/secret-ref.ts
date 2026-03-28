import * as Schema from "effect/Schema";

export const SecretRefSchema = Schema.Struct({
  providerId: Schema.String,
  handle: Schema.String,
});

export type SecretRef = typeof SecretRefSchema.Type;
