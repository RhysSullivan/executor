import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  AccountIdSchema,
  OAuthTokenIdSchema,
  OrganizationIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const OAuthTokenSchema = Schema.Struct({
  id: OAuthTokenIdSchema,
  workspaceId: WorkspaceIdSchema,
  organizationId: Schema.NullOr(OrganizationIdSchema),
  accountId: Schema.NullOr(AccountIdSchema),
  sourceId: SourceIdSchema,
  issuer: Schema.String,
  accessTokenRef: Schema.String,
  refreshTokenRef: Schema.NullOr(Schema.String),
  scope: Schema.Array(Schema.String),
  expiresAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type OAuthToken = typeof OAuthTokenSchema.Type;
