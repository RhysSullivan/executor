import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { AccountIdSchema, OrganizationIdSchema, WorkspaceIdSchema } from "../ids";

export const WorkspaceSchema = Schema.Struct({
  id: WorkspaceIdSchema,
  organizationId: Schema.NullOr(OrganizationIdSchema),
  name: Schema.String,
  createdByAccountId: Schema.NullOr(AccountIdSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type Workspace = typeof WorkspaceSchema.Type;
