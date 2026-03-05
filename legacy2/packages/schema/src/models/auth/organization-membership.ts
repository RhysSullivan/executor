import { Schema } from "effect";

import { TimestampMsSchema } from "../../common";
import { OrganizationMemberStatusSchema } from "../../enums";
import {
  AccountIdSchema,
  OrganizationIdSchema,
  OrganizationMemberIdSchema,
} from "../../ids";
import { RoleSchema } from "./role";

export const OrganizationMembershipSchema = Schema.Struct({
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
});

export type OrganizationMembership = typeof OrganizationMembershipSchema.Type;
