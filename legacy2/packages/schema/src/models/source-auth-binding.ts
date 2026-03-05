import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { AuthBindingScopeTypeSchema } from "../enums";
import {
  AccountIdSchema,
  AuthConnectionIdSchema,
  OrganizationIdSchema,
  SourceAuthBindingIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const SourceAuthBindingSchema = Schema.Struct({
  id: SourceAuthBindingIdSchema,
  sourceId: SourceIdSchema,
  connectionId: AuthConnectionIdSchema,
  organizationId: OrganizationIdSchema,
  workspaceId: Schema.NullOr(WorkspaceIdSchema),
  accountId: Schema.NullOr(AccountIdSchema),
  scopeType: AuthBindingScopeTypeSchema,
  selector: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SourceAuthBinding = typeof SourceAuthBindingSchema.Type;
