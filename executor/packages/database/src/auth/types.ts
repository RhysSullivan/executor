import type { Doc, Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx } from "../../convex/_generated/server";

export type DbCtx = Pick<MutationCtx, "db">;
export type RunQueryCtx = Pick<MutationCtx, "runQuery">;

export type OrganizationRole = "owner" | "admin" | "member" | "billing_admin";
export type OrganizationMemberStatus = "active" | "pending" | "removed";
export type WorkspaceMemberRole = Doc<"workspaceMembers">["role"];

export type OrganizationId = Id<"organizations">;
export type WorkspaceId = Id<"workspaces">;
export type AccountId = Id<"accounts">;
