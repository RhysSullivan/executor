import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { AuthActorTypeSchema, AuthAuditEventTypeSchema } from "../enums";
import {
  AccountIdSchema,
  AuthAuditEventIdSchema,
  AuthConnectionIdSchema,
  OrganizationIdSchema,
  SourceIdSchema,
} from "../ids";

export const AuthAuditEventSchema = Schema.Struct({
  id: AuthAuditEventIdSchema,
  organizationId: OrganizationIdSchema,
  connectionId: AuthConnectionIdSchema,
  sourceId: Schema.NullOr(SourceIdSchema),
  eventType: AuthAuditEventTypeSchema,
  actorType: AuthActorTypeSchema,
  actorId: Schema.NullOr(AccountIdSchema),
  outcome: Schema.String,
  reasonCode: Schema.NullOr(Schema.String),
  detailsJson: Schema.NullOr(Schema.String),
  correlationId: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
});

export type AuthAuditEvent = typeof AuthAuditEventSchema.Type;
