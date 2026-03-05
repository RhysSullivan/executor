import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { organizationsTable } from "../../../persistence/schema";
import { TimestampMsSchema } from "../../common";
import { AccountIdSchema, OrganizationIdSchema } from "../../ids";

export const OrganizationStatusSchema = Schema.Literal(
  "active",
  "suspended",
  "archived",
);

const organizationSchemaOverrides = {
  id: OrganizationIdSchema,
  status: OrganizationStatusSchema,
  createdByAccountId: Schema.NullOr(AccountIdSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const OrganizationSchema = createSelectSchema(
  organizationsTable,
  organizationSchemaOverrides,
);

export const OrganizationInsertSchema = createInsertSchema(
  organizationsTable,
  organizationSchemaOverrides,
);

export const OrganizationUpdateSchema = createUpdateSchema(
  organizationsTable,
  organizationSchemaOverrides,
);

export type OrganizationStatus = typeof OrganizationStatusSchema.Type;
export type Organization = typeof OrganizationSchema.Type;
