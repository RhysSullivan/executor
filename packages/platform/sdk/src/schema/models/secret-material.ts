import {
  Schema,
} from "effect";

import {
  TimestampMsSchema,
} from "../common";
import {
  SecretMaterialIdSchema,
} from "../ids";

export const SecretMaterialPurposeSchema = Schema.Literal(
  "auth_material",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_client_info",
);

export const SecretMaterialSchema = Schema.Struct({
  id: SecretMaterialIdSchema,
  name: Schema.NullOr(Schema.String),
  purpose: SecretMaterialPurposeSchema,
  providerId: Schema.String,
  handle: Schema.String,
  value: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SecretMaterialPurpose = typeof SecretMaterialPurposeSchema.Type;
export type SecretMaterial = typeof SecretMaterialSchema.Type;
