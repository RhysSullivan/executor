import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { organizationMembershipsTable } from "../../../persistence/schema";
import { TimestampMsSchema } from "../../common";
import {
  AccountIdSchema,
  OrganizationIdSchema,
  OrganizationMemberIdSchema,
} from "../../ids";

export const RoleSchema = Schema.Literal("viewer", "editor", "admin", "owner");

export const OrganizationMemberStatusSchema = Schema.Literal(
  "invited",
  "active",
  "suspended",
  "removed",
);

const organizationMembershipSchemaOverrides = {
  id: OrganizationMemberIdSchema,
  organizationId: OrganizationIdSchema,
  accountId: AccountIdSchema,
  role: RoleSchema,
  status: OrganizationMemberStatusSchema,
  billable: Schema.Boolean,
  invitedByAccountId: Schema.NullOr(AccountIdSchema),
  joinedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const OrganizationMembershipSchema = createSelectSchema(
  organizationMembershipsTable,
  organizationMembershipSchemaOverrides,
);

export const OrganizationMembershipInsertSchema = createInsertSchema(
  organizationMembershipsTable,
  organizationMembershipSchemaOverrides,
);

export const OrganizationMembershipUpdateSchema = createUpdateSchema(
  organizationMembershipsTable,
  organizationMembershipSchemaOverrides,
);

export type Role = typeof RoleSchema.Type;
export type OrganizationMemberStatus = typeof OrganizationMemberStatusSchema.Type;
export type OrganizationMembership = typeof OrganizationMembershipSchema.Type;
