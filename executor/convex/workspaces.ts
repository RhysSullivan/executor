import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { optionalAccountQuery, authedMutation } from "./lib/functionBuilders";
import { getOrganizationMembership, slugify } from "./lib/identity";
import { ensureUniqueSlug } from "./lib/slug";

type WorkspaceResult = {
  id: Id<"workspaces">;
  organizationId: Id<"organizations">;
  name: string;
  slug: string;
  iconUrl: string | null;
  createdAt: number;
};

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
  ctx: Pick<QueryCtx, "storage"> | Pick<MutationCtx, "storage">,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceResult> {
  const iconUrl = workspace.iconStorageId ? await ctx.storage.getUrl(workspace.iconStorageId) : null;
  return {
    id: workspace._id,
    organizationId: workspace.organizationId,
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
      return await Promise.all(docs.map(async (workspace) => await toWorkspaceResult(ctx, workspace)));
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
      for (const workspace of docs) {
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
