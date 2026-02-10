import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { optionalAccountQuery, authedMutation } from "../lib/functionBuilders";
import { getOrganizationMembership, slugify } from "../lib/identity";
import { ensureUniqueSlug } from "../lib/slug";

type WorkspaceResult = {
  id: Id<"workspaces">;
  organizationId: Id<"organizations">;
  organizationName: string;
  organizationSlug: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  createdAt: number;
};

async function workspaceHasActivity(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  const [
    task,
    approval,
    policy,
    credential,
    toolSource,
    agentTask,
    member,
  ] = await Promise.all([
    ctx.db.query("tasks").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("approvals").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("accessPolicies").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
      .first(),
    ctx.db.query("toolSources").withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("agentTasks").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
  ]);

  return Boolean(task || approval || policy || credential || toolSource || agentTask || member);
}

async function filterDisplayWorkspaces(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  workspaces: Doc<"workspaces">[],
): Promise<Doc<"workspaces">[]> {
  if (workspaces.length <= 1) {
    return workspaces;
  }

  const starterWorkspace = workspaces.find((workspace) => workspace.name === "Default Workspace");
  if (!starterWorkspace) {
    return workspaces;
  }

  const hasActivity = await workspaceHasActivity(ctx, starterWorkspace._id);
  if (hasActivity) {
    return workspaces;
  }

  return workspaces.filter((workspace) => workspace._id !== starterWorkspace._id);
}

async function cleanupEmptyStarterWorkspace(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Id<"organizations">,
  preserveWorkspaceId: Id<"workspaces">,
): Promise<void> {
  const docs = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
    .collect();

  if (docs.length <= 1) {
    return;
  }

  const starterWorkspace = docs.find(
    (workspace) => workspace.name === "Default Workspace" && workspace._id !== preserveWorkspaceId,
  );
  if (!starterWorkspace) {
    return;
  }

  const hasActivity = await workspaceHasActivity(ctx, starterWorkspace._id);
  if (hasActivity) {
    return;
  }

  await ctx.db.delete(starterWorkspace._id);
}

async function ensureUniqueOrganizationSlug(ctx: Pick<MutationCtx, "db">, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName);
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}

async function ensureUniqueWorkspaceSlug(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Id<"organizations">,
  baseName: string,
): Promise<string> {
  const baseSlug = slugify(baseName);
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("workspaces")
      .withIndex("by_organization_slug", (q) => q.eq("organizationId", organizationId).eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}

async function toWorkspaceResult(
  ctx: (Pick<QueryCtx, "db" | "storage"> | Pick<MutationCtx, "db" | "storage">),
  workspace: Doc<"workspaces">,
): Promise<WorkspaceResult> {
  const organization = await ctx.db.get(workspace.organizationId);
  if (!organization) {
    throw new Error("Workspace organization not found");
  }

  const iconUrl = workspace.iconStorageId ? await ctx.storage.getUrl(workspace.iconStorageId) : null;
  return {
    id: workspace._id,
    organizationId: workspace.organizationId,
    organizationName: organization.name,
    organizationSlug: organization.slug,
    name: workspace.name,
    slug: workspace.slug,
    iconUrl,
    createdAt: workspace.createdAt,
  };
}

export const create = authedMutation({
  args: {
    name: v.string(),
    organizationId: v.optional(v.id("organizations")),
    iconStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const account = ctx.account;
    const name = args.name.trim();
    if (name.length < 2) {
      throw new Error("Workspace name must be at least 2 characters");
    }

    let organizationId = args.organizationId;
    if (organizationId) {
      const membership = await getOrganizationMembership(ctx, organizationId, account._id);
      if (!membership || membership.status !== "active") {
        throw new Error("You are not a member of this organization");
      }
    } else {
      const now = Date.now();
      const organizationSlug = await ensureUniqueOrganizationSlug(ctx, name);
      organizationId = await ctx.db.insert("organizations", {
        slug: organizationSlug,
        name,
        status: "active",
        createdByAccountId: account._id,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert("organizationMembers", {
        organizationId,
        accountId: account._id,
        role: "owner",
        status: "active",
        billable: true,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    const now = Date.now();
    const slug = await ensureUniqueWorkspaceSlug(ctx, organizationId, name);

    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      slug,
      name,
      iconStorageId: args.iconStorageId,
      plan: "free",
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) {
      throw new Error("Failed to create workspace");
    }

    await cleanupEmptyStarterWorkspace(ctx, organizationId, workspaceId);

    return await toWorkspaceResult(ctx, workspace);
  },
});

export const list = optionalAccountQuery({
  args: {
    organizationId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, args) => {
    const account = ctx.account;
    if (!account) {
      return [];
    }

    const organizationId = args.organizationId;
    if (organizationId) {
      const membership = await getOrganizationMembership(ctx, organizationId, account._id);
      if (!membership || membership.status !== "active") {
        return [];
      }

      const docs = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
        .collect();
      const filteredDocs = await filterDisplayWorkspaces(ctx, docs);
      return await Promise.all(filteredDocs.map(async (workspace) => await toWorkspaceResult(ctx, workspace)));
    }

    const memberships = await ctx.db
      .query("organizationMembers")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();

    const activeMemberships = memberships.filter((membership) => membership.status === "active");
    const allWorkspaces: WorkspaceResult[] = [];

    for (const membership of activeMemberships) {
      const docs = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_created", (q) => q.eq("organizationId", membership.organizationId))
        .collect();
      const filteredDocs = await filterDisplayWorkspaces(ctx, docs);
      for (const workspace of filteredDocs) {
        allWorkspaces.push(await toWorkspaceResult(ctx, workspace));
      }
    }

    return Array.from(new Map(allWorkspaces.map((workspace) => [workspace.id, workspace])).values());
  },
});

export const generateWorkspaceIconUploadUrl = authedMutation({
  args: {},
  handler: async (ctx) => {
    void ctx.account;
    return await ctx.storage.generateUploadUrl();
  },
});
