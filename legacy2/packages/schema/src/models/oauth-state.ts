import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { AuthConnectionIdSchema, OAuthStateIdSchema } from "../ids";

export const OAuthStateSchema = Schema.Struct({
  id: OAuthStateIdSchema,
  connectionId: AuthConnectionIdSchema,
  backend: Schema.String,
  accessTokenHandle: Schema.String,
  refreshTokenHandle: Schema.NullOr(Schema.String),
  clientSecretHandle: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(TimestampMsSchema),
  scope: Schema.NullOr(Schema.String),
  tokenType: Schema.NullOr(Schema.String),
  issuer: Schema.NullOr(Schema.String),
  refreshConfigJson: Schema.NullOr(Schema.String),
  tokenVersion: Schema.Number,
  leaseHolder: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(TimestampMsSchema),
  leaseFence: Schema.Number,
  lastRefreshAt: Schema.NullOr(TimestampMsSchema),
  lastRefreshErrorClass: Schema.NullOr(Schema.String),
  lastRefreshError: Schema.NullOr(Schema.String),
  reauthRequiredAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type OAuthState = typeof OAuthStateSchema.Type;
