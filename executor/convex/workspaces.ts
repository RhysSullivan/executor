import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getOrganizationMembership, requireAccountForRequest, resolveAccountForRequest, slugify } from "./lib/identity";

type WorkspaceResult = {
  id: string;
  organizationId: string | null;
  name: string;
  slug: string;
  kind: string;
  iconUrl: string | null;
  runtimeWorkspaceId: string;
  createdAt: number;
};

async function ensureUniqueWorkspaceSlug(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Id<"organizations"> | undefined,
  baseName: string,
): Promise<string> {
  const baseSlug = slugify(baseName);
  const existing = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_slug", (q) => q.eq("organizationId", organizationId).eq("slug", baseSlug))
    .unique();
  if (!existing) {
    return baseSlug;
  }

  for (let i = 0; i < 20; i += 1) {
    const candidate = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
    const collision = await ctx.db
      .query("workspaces")
      .withIndex("by_organization_slug", (q) => q.eq("organizationId", organizationId).eq("slug", candidate))
      .unique();
    if (!collision) {
      return candidate;
    }
  }

  return `${baseSlug}-${Date.now()}`;
}

async function toWorkspaceResult(
  ctx: Pick<QueryCtx, "storage"> | Pick<MutationCtx, "storage">,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceResult> {
  const iconUrl = workspace.iconStorageId ? await ctx.storage.getUrl(workspace.iconStorageId) : null;
  return {
    id: String(workspace._id),
    organizationId: workspace.organizationId ? String(workspace.organizationId) : null,
    name: workspace.name,
    slug: workspace.slug,
    kind: workspace.kind,
    iconUrl,
    runtimeWorkspaceId: workspace.legacyWorkspaceId ?? `ws_${String(workspace._id)}`,
    createdAt: workspace.createdAt,
  };
}

export const create = mutation({
  args: {
    name: v.string(),
    organizationId: v.optional(v.id("organizations")),
    iconStorageId: v.optional(v.id("_storage")),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const name = args.name.trim();
    if (name.length < 2) {
      throw new Error("Workspace name must be at least 2 characters");
    }

    if (args.organizationId) {
      const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
      if (!membership || membership.status !== "active") {
        throw new Error("You are not a member of this organization");
      }
    }

    const now = Date.now();
    const slug = await ensureUniqueWorkspaceSlug(ctx, args.organizationId, name);

    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId: args.organizationId,
      slug,
      name,
      iconStorageId: args.iconStorageId,
      kind: args.organizationId ? "organization" : "personal",
      visibility: args.organizationId ? "organization" : "private",
      plan: "free",
      legacyWorkspaceId: `ws_${crypto.randomUUID()}`,
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

export const list = query({
  args: {
    organizationId: v.optional(v.id("organizations")),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) {
      return [];
    }

    if (args.organizationId) {
      const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
      if (!membership || membership.status !== "active") {
        return [];
      }

      const docs = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_created", (q) => q.eq("organizationId", args.organizationId))
        .collect();
      return await Promise.all(docs.map(async (workspace) => await toWorkspaceResult(ctx, workspace)));
    }

    const docs = await ctx.db
      .query("workspaces")
      .withIndex("by_creator_created", (q) => q.eq("createdByAccountId", account._id))
      .collect();

    const personal = docs.filter((workspace) => !workspace.organizationId);
    return await Promise.all(personal.map(async (workspace) => await toWorkspaceResult(ctx, workspace)));
  },
});
