import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { workspacesTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import { AccountIdSchema, OrganizationIdSchema, WorkspaceIdSchema } from "../ids";

const workspaceSchemaOverrides = {
  id: WorkspaceIdSchema,
  organizationId: OrganizationIdSchema,
  createdByAccountId: Schema.NullOr(AccountIdSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const WorkspaceSchema = createSelectSchema(workspacesTable, workspaceSchemaOverrides);

export const WorkspaceInsertSchema = createInsertSchema(
  workspacesTable,
  workspaceSchemaOverrides,
);

export const WorkspaceUpdateSchema = createUpdateSchema(
  workspacesTable,
  workspaceSchemaOverrides,
);

export type Workspace = typeof WorkspaceSchema.Type;
