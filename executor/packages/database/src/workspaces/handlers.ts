import type { Doc, Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { getOrganizationMembership, isAdminRole, slugify } from "../../../core/src/identity";
import { ensureUniqueSlug } from "../../../core/src/slug";
import { upsertOrganizationMembership } from "../auth/memberships";
import { safeRunAfter } from "../lib/scheduler";

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

type OptionalAccountCtx = QueryCtx & {
  account: Doc<"accounts"> | null;
};

type AuthedCtx = MutationCtx & {
  account: Doc<"accounts">;
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
  ctx: Pick<QueryCtx, "db" | "storage"> | Pick<MutationCtx, "db" | "storage">,
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

export async function createWorkspaceHandler(
  ctx: AuthedCtx,
  args: { name: string; organizationId?: Id<"organizations">; iconStorageId?: Id<"_storage"> },
) {
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
    if (!isAdminRole(membership.role)) {
      throw new Error("Only organization admins can create workspaces in this organization");
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

    await upsertOrganizationMembership(ctx, {
      organizationId,
      accountId: account._id,
      role: "owner",
      status: "active",
      billable: true,
      now,
    });
  }

  if (!organizationId) {
    throw new Error("Organization is required to create workspace");
  }

  const now = Date.now();
  const slug = await ensureUniqueWorkspaceSlug(ctx, organizationId, name);

  const workspaceId = await ctx.db.insert("workspaces", {
    organizationId,
    slug,
    name,
    iconStorageId: args.iconStorageId,
    createdByAccountId: account._id,
    createdAt: now,
    updatedAt: now,
  });

  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    throw new Error("Failed to create workspace");
  }

  await safeRunAfter(ctx.scheduler, 0, internal.executorNode.rebuildToolInventoryInternal, {
    workspaceId,
    accountId: account._id,
  });

  return await toWorkspaceResult(ctx, workspace);
}

export async function listWorkspacesHandler(ctx: OptionalAccountCtx, args: { organizationId?: Id<"organizations"> }) {
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
}

export async function generateWorkspaceIconUploadUrlHandler(ctx: AuthedCtx) {
  void ctx.account;
  return await ctx.storage.generateUploadUrl();
}
