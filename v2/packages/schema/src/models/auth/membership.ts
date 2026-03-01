import { Schema } from "effect";

import { TimestampMsSchema } from "../../common";
import { AccountIdSchema, WorkspaceIdSchema } from "../../ids";
import { RoleSchema } from "./role";

export const MembershipStatusSchema = Schema.Literal(
  "active",
  "suspended",
  "revoked",
);

export const WorkspaceMembershipSchema = Schema.Struct({
  accountId: AccountIdSchema,
  workspaceId: WorkspaceIdSchema,
  role: RoleSchema,
  status: MembershipStatusSchema,
  grantedAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type MembershipStatus = typeof MembershipStatusSchema.Type;
export type WorkspaceMembership = typeof WorkspaceMembershipSchema.Type;
