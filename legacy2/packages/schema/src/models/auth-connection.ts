import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  AuthConnectionStatusSchema,
  AuthConnectionStrategySchema,
  AuthOwnerTypeSchema,
} from "../enums";
import {
  AccountIdSchema,
  AuthConnectionIdSchema,
  OrganizationIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const AuthConnectionSchema = Schema.Struct({
  id: AuthConnectionIdSchema,
  organizationId: OrganizationIdSchema,
  workspaceId: Schema.NullOr(WorkspaceIdSchema),
  accountId: Schema.NullOr(AccountIdSchema),
  ownerType: AuthOwnerTypeSchema,
  strategy: AuthConnectionStrategySchema,
  displayName: Schema.String,
  status: AuthConnectionStatusSchema,
  statusReason: Schema.NullOr(Schema.String),
  lastAuthErrorClass: Schema.NullOr(Schema.String),
  metadataJson: Schema.NullOr(Schema.String),
  additionalHeadersJson: Schema.NullOr(Schema.String),
  createdByAccountId: Schema.NullOr(AccountIdSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
  lastUsedAt: Schema.NullOr(TimestampMsSchema),
});

export type AuthConnection = typeof AuthConnectionSchema.Type;
