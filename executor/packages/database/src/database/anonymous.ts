import type { Doc } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx } from "../../convex/_generated/server";
import { slugify } from "../../../core/src/identity";
import { ensureUniqueSlug } from "../../../core/src/slug";
import { upsertOrganizationMembership } from "../auth/memberships";

async function ensureUniqueOrganizationSlug(ctx: Pick<MutationCtx, "db">, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName, "workspace");
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}


export async function ensureAnonymousIdentity(
  ctx: MutationCtx,
  params: {
    sessionId: string;
    workspaceId?: Doc<"workspaces">["_id"];
    actorId: string;
    timestamp: number;
  },
) {
  const anonymousOrganizationName = "Anonymous Organization";
  const anonymousWorkspaceName = "Anonymous Workspace";
  const now = params.timestamp;

  let account = await ctx.db
    .query("accounts")
    .withIndex("by_provider", (q) => q.eq("provider", "anonymous").eq("providerAccountId", params.actorId))
    .unique();

  if (!account) {
    const accountId = await ctx.db.insert("accounts", {
      provider: "anonymous",
      providerAccountId: params.actorId,
      email: `${params.actorId}@guest.executor.local`,
      name: "Guest User",
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });
    account = await ctx.db.get(accountId);
    if (!account) {
      throw new Error("Failed to create anonymous account");
    }
  } else {
    await ctx.db.patch(account._id, { updatedAt: now, lastLoginAt: now });
  }

  let workspace = params.workspaceId ? await ctx.db.get(params.workspaceId) : null;

  let organizationId: Doc<"organizations">["_id"];

  if (!workspace) {
    const organizationSlug = await ensureUniqueOrganizationSlug(ctx, anonymousOrganizationName);
    organizationId = await ctx.db.insert("organizations", {
      slug: organizationSlug,
      name: anonymousOrganizationName,
      status: "active",
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      slug: `anonymous-${crypto.randomUUID().slice(0, 8)}`,
      name: anonymousWorkspaceName,
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });
    workspace = await ctx.db.get(workspaceId);
    if (!workspace) {
      throw new Error("Failed to create anonymous workspace");
    }
  } else {
    organizationId = workspace.organizationId;
  }

  await upsertOrganizationMembership(ctx, {
    organizationId,
    accountId: account._id,
    role: "owner",
    status: "active",
    billable: true,
    now,
  });

  let user = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspace._id).eq("accountId", account._id))
    .unique();

  if (!user) {
    throw new Error("Failed to project anonymous workspace membership");
  }

  await ctx.db.patch(user._id, { updatedAt: now });

  return {
    accountId: account._id,
    workspaceId: workspace._id,
    userId: user._id,
  };
}
