import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx } from "../../convex/_generated/server";

type DeleteBatchResult = {
  deleted: number;
  done: boolean;
};

async function deleteDocs(
  ctx: Pick<MutationCtx, "db">,
  docs: Array<{ _id: Id<any> }>,
): Promise<number> {
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length;
}

async function deleteWorkspaceDataBatch(
  ctx: Pick<MutationCtx, "db" | "storage">,
  workspaceId: Id<"workspaces">,
  maxDeletes: number,
): Promise<DeleteBatchResult> {
  let deleted = 0;

  while (deleted < maxDeletes) {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
      .first();
    if (!task) {
      break;
    }

    const remaining = maxDeletes - deleted;
    const events = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", task.taskId))
      .take(remaining);
    if (events.length > 0) {
      deleted += await deleteDocs(ctx, events);
      if (deleted >= maxDeletes) {
        return { deleted, done: false };
      }
      continue;
    }

    await ctx.db.delete(task._id);
    deleted += 1;
  }

  const deleteFromWorkspaceIndex = async (
    table:
      | "approvals"
      | "toolRoleBindings"
      | "sourceCredentials"
      | "toolSources"
      | "anonymousSessions"
      | "storageInstances",
    index:
      | "by_workspace_created"
      | "by_workspace_updated"
      | "by_workspace_account"
      | "by_workspace_status_updated",
  ): Promise<boolean> => {
    if (deleted >= maxDeletes) {
      return true;
    }

    const remaining = maxDeletes - deleted;
    const docs = await ctx.db
      .query(table)
      .withIndex(index as never, (q: any) => q.eq("workspaceId", workspaceId))
      .take(remaining);
    if (docs.length === 0) {
      return false;
    }

    deleted += await deleteDocs(ctx, docs as Array<{ _id: Id<any> }>);
    return deleted >= maxDeletes;
  };

  if (await deleteFromWorkspaceIndex("approvals", "by_workspace_created")) {
    return { deleted, done: false };
  }
  if (await deleteFromWorkspaceIndex("toolRoleBindings", "by_workspace_created")) {
    return { deleted, done: false };
  }
  if (await deleteFromWorkspaceIndex("sourceCredentials", "by_workspace_created")) {
    return { deleted, done: false };
  }
  if (await deleteFromWorkspaceIndex("toolSources", "by_workspace_updated")) {
    return { deleted, done: false };
  }
  if (await deleteFromWorkspaceIndex("anonymousSessions", "by_workspace_account")) {
    return { deleted, done: false };
  }
  if (await deleteFromWorkspaceIndex("storageInstances", "by_workspace_updated")) {
    return { deleted, done: false };
  }

  const deleteRegistryPage = async (
    table: "workspaceToolRegistry" | "workspaceToolRegistryPayloads" | "workspaceToolNamespaces",
  ): Promise<boolean> => {
    if (deleted >= maxDeletes) {
      return true;
    }
    const remaining = maxDeletes - deleted;
    const docs = await ctx.db
      .query(table)
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .take(remaining);
    if (docs.length === 0) {
      return false;
    }
    deleted += await deleteDocs(ctx, docs as Array<{ _id: Id<any> }>);
    return deleted >= maxDeletes;
  };

  if (await deleteRegistryPage("workspaceToolRegistry")) {
    return { deleted, done: false };
  }
  if (await deleteRegistryPage("workspaceToolRegistryPayloads")) {
    return { deleted, done: false };
  }
  if (await deleteRegistryPage("workspaceToolNamespaces")) {
    return { deleted, done: false };
  }

  if (deleted < maxDeletes) {
    const state = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (state) {
      await ctx.db.delete(state._id);
      deleted += 1;
      if (deleted >= maxDeletes) {
        return { deleted, done: false };
      }
    }
  }

  const hasDependents = await Promise.all([
    ctx.db.query("tasks").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("approvals").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("toolRoleBindings").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("sourceCredentials").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("toolSources").withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("anonymousSessions").withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("storageInstances").withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("workspaceToolRegistry").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("workspaceToolRegistryPayloads").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("workspaceToolNamespaces").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("workspaceToolRegistryState").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
  ]);

  if (hasDependents.some(Boolean)) {
    return { deleted, done: false };
  }

  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    return { deleted, done: true };
  }

  if (workspace.iconStorageId) {
    await ctx.storage.delete(workspace.iconStorageId).catch(() => {});
  }

  if (deleted >= maxDeletes) {
    return { deleted, done: false };
  }

  await ctx.db.delete(workspace._id);
  deleted += 1;
  return { deleted, done: true };
}

async function deleteOrganizationDataBatch(
  ctx: Pick<MutationCtx, "db" | "storage">,
  organizationId: Id<"organizations">,
  maxDeletes: number,
): Promise<DeleteBatchResult> {
  let deleted = 0;

  const deleteByOrg = async (
    table:
      | "invites"
      | "billingCustomers"
      | "billingSubscriptions"
      | "billingSeatState"
      | "toolRoleBindings"
      | "toolRoleRules"
      | "toolRoles"
      | "sourceCredentials"
      | "toolSources"
      | "organizationMembers",
    index: "by_org" | "by_org_created" | "by_organization_created" | "by_organization_updated",
  ): Promise<boolean> => {
    if (deleted >= maxDeletes) {
      return true;
    }

    const remaining = maxDeletes - deleted;
    const docs = await ctx.db
      .query(table)
      .withIndex(index as never, (q: any) => q.eq("organizationId", organizationId))
      .take(remaining);
    if (docs.length === 0) {
      return false;
    }

    deleted += await deleteDocs(ctx, docs as Array<{ _id: Id<any> }>);
    return deleted >= maxDeletes;
  };

  if (await deleteByOrg("invites", "by_org")) return { deleted, done: false };
  if (await deleteByOrg("billingCustomers", "by_org")) return { deleted, done: false };
  if (await deleteByOrg("billingSubscriptions", "by_org")) return { deleted, done: false };
  if (await deleteByOrg("billingSeatState", "by_org")) return { deleted, done: false };
  if (await deleteByOrg("toolRoleBindings", "by_org_created")) return { deleted, done: false };
  if (await deleteByOrg("toolRoleRules", "by_org_created")) return { deleted, done: false };
  if (await deleteByOrg("toolRoles", "by_org_created")) return { deleted, done: false };
  if (await deleteByOrg("sourceCredentials", "by_organization_created")) return { deleted, done: false };
  if (await deleteByOrg("toolSources", "by_organization_updated")) return { deleted, done: false };

  while (deleted < maxDeletes) {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
      .first();
    if (!workspace) {
      break;
    }

    const workspaceResult = await deleteWorkspaceDataBatch(ctx, workspace._id, maxDeletes - deleted);
    deleted += workspaceResult.deleted;
    if (!workspaceResult.done || deleted >= maxDeletes) {
      return { deleted, done: false };
    }
  }

  if (await deleteByOrg("organizationMembers", "by_org")) return { deleted, done: false };

  const hasDependents = await Promise.all([
    ctx.db.query("invites").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("billingCustomers").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("billingSubscriptions").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("billingSeatState").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("toolRoleBindings").withIndex("by_org_created", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("toolRoleRules").withIndex("by_org_created", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("toolRoles").withIndex("by_org_created", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("sourceCredentials").withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("toolSources").withIndex("by_organization_updated", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("workspaces").withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId)).first(),
    ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first(),
  ]);

  if (hasDependents.some(Boolean)) {
    return { deleted, done: false };
  }

  if (deleted >= maxDeletes) {
    return { deleted, done: false };
  }

  await ctx.db.delete(organizationId);
  deleted += 1;
  return { deleted, done: true };
}

async function deleteByIndex(
  ctx: Pick<MutationCtx, "db">,
  args: {
    table: "organizationMembers" | "invites" | "anonymousSessions" | "accountLinks";
    index: "by_account" | "by_invited_by_created" | "by_source_account" | "by_target_account";
    field: "accountId" | "invitedByAccountId" | "sourceAccountId" | "targetAccountId";
    accountId: Id<"accounts">;
    maxDeletes: number;
  },
): Promise<number> {
  const docs = await ctx.db
    .query(args.table)
    .withIndex(args.index as never, (q: any) => q.eq(args.field, args.accountId))
    .take(args.maxDeletes);
  if (docs.length === 0) {
    return 0;
  }

  return await deleteDocs(ctx, docs as Array<{ _id: Id<any> }>);
}

export async function deleteCurrentAccountBatchStep(
  ctx: Pick<MutationCtx, "db" | "storage">,
  args: {
    accountId: Id<"accounts">;
    maxDeletes: number;
  },
): Promise<{ done: boolean; deleted: number; accountDeleted: boolean }> {
  let remaining = Math.max(1, Math.min(1000, Math.floor(args.maxDeletes)));
  let deleted = 0;

  while (remaining > 0) {
    const ownedOrganization = await ctx.db
      .query("organizations")
      .withIndex("by_creator_created", (q) => q.eq("createdByAccountId", args.accountId))
      .first();
    if (!ownedOrganization) {
      break;
    }

    const orgResult = await deleteOrganizationDataBatch(ctx, ownedOrganization._id, remaining);
    deleted += orgResult.deleted;
    remaining -= orgResult.deleted;
    if (!orgResult.done) {
      return { done: false, deleted, accountDeleted: false };
    }
    if (orgResult.deleted === 0) {
      break;
    }
  }

  if (remaining > 0) {
    const removedMemberships = await deleteByIndex(ctx, {
      table: "organizationMembers",
      index: "by_account",
      field: "accountId",
      accountId: args.accountId,
      maxDeletes: remaining,
    });
    deleted += removedMemberships;
    remaining -= removedMemberships;
  }

  if (remaining > 0) {
    const removedInvites = await deleteByIndex(ctx, {
      table: "invites",
      index: "by_invited_by_created",
      field: "invitedByAccountId",
      accountId: args.accountId,
      maxDeletes: remaining,
    });
    deleted += removedInvites;
    remaining -= removedInvites;
  }

  if (remaining > 0) {
    const removedSessions = await deleteByIndex(ctx, {
      table: "anonymousSessions",
      index: "by_account",
      field: "accountId",
      accountId: args.accountId,
      maxDeletes: remaining,
    });
    deleted += removedSessions;
    remaining -= removedSessions;
  }

  if (remaining > 0) {
    const removedSourceLinks = await deleteByIndex(ctx, {
      table: "accountLinks",
      index: "by_source_account",
      field: "sourceAccountId",
      accountId: args.accountId,
      maxDeletes: remaining,
    });
    deleted += removedSourceLinks;
    remaining -= removedSourceLinks;
  }

  if (remaining > 0) {
    const removedTargetLinks = await deleteByIndex(ctx, {
      table: "accountLinks",
      index: "by_target_account",
      field: "targetAccountId",
      accountId: args.accountId,
      maxDeletes: remaining,
    });
    deleted += removedTargetLinks;
    remaining -= removedTargetLinks;
  }

  const stillLinked = await Promise.all([
    ctx.db.query("organizations").withIndex("by_creator_created", (q) => q.eq("createdByAccountId", args.accountId)).first(),
    ctx.db.query("organizationMembers").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).first(),
    ctx.db.query("invites").withIndex("by_invited_by_created", (q) => q.eq("invitedByAccountId", args.accountId)).first(),
    ctx.db.query("anonymousSessions").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).first(),
    ctx.db.query("accountLinks").withIndex("by_source_account", (q) => q.eq("sourceAccountId", args.accountId)).first(),
    ctx.db.query("accountLinks").withIndex("by_target_account", (q) => q.eq("targetAccountId", args.accountId)).first(),
  ]);

  if (stillLinked.some(Boolean)) {
    return { done: false, deleted, accountDeleted: false };
  }

  if (remaining <= 0) {
    return { done: false, deleted, accountDeleted: false };
  }

  const account = await ctx.db.get(args.accountId);
  if (!account) {
    return { done: true, deleted, accountDeleted: true };
  }

  await ctx.db.delete(args.accountId);
  return { done: true, deleted: deleted + 1, accountDeleted: true };
}
