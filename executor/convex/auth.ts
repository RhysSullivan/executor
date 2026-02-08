import { AuthKit, type AuthFunctions } from "@convex-dev/workos-authkit";
import { components, internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./_generated/server";
import { ensureUniqueSlug } from "./lib/slug";

type DbCtx = Pick<MutationCtx, "db">;
type RunQueryCtx = Pick<MutationCtx, "runQuery">;
type WorkosEventCtx = Pick<MutationCtx, "db" | "runQuery">;
type OrganizationRole = "owner" | "admin" | "member" | "billing_admin";
type OrganizationMemberStatus = "active" | "pending" | "removed";

const workosEnabled = Boolean(
  process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY && process.env.WORKOS_WEBHOOK_SECRET,
);

const authFunctions: AuthFunctions = internal.auth;

const authKitInstance = workosEnabled
  ? new AuthKit<DataModel>(components.workOSAuthKit, {
      authFunctions,
      additionalEventTypes: [
        "organization.created",
        "organization.updated",
        "organization.deleted",
        "organization_membership.created",
        "organization_membership.updated",
        "organization_membership.deleted",
      ],
    })
  : null;

export const authKit =
  authKitInstance ??
  ({
    registerRoutes: () => {},
  } as Pick<AuthKit<DataModel>, "registerRoutes">);

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

async function getAccountByWorkosId(ctx: DbCtx, workosUserId: string) {
  return await ctx.db
    .query("accounts")
    .withIndex("by_provider", (q) => q.eq("provider", "workos").eq("providerAccountId", workosUserId))
    .unique();
}

async function getWorkspaceByWorkosOrgId(ctx: DbCtx, workosOrgId: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_workos_org_id", (q) => q.eq("workosOrgId", workosOrgId))
    .unique();
}

async function getOrganizationByWorkosOrgId(ctx: DbCtx, workosOrgId: string) {
  return await ctx.db
    .query("organizations")
    .withIndex("by_workos_org_id", (q) => q.eq("workosOrgId", workosOrgId))
    .unique();
}

async function ensureUniqueOrganizationSlug(ctx: DbCtx, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName);
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}

async function upsertOrganizationMembership(
  ctx: DbCtx,
  args: {
    organizationId: Id<"organizations">;
    accountId: Id<"accounts">;
    role: OrganizationRole;
    status: OrganizationMemberStatus;
    billable: boolean;
    invitedByAccountId?: Id<"accounts">;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", args.organizationId).eq("accountId", args.accountId))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      role: args.role,
      status: args.status,
      billable: args.billable,
      invitedByAccountId: args.invitedByAccountId,
      joinedAt: args.status === "active" ? (existing.joinedAt ?? args.now) : existing.joinedAt,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("organizationMembers", {
    organizationId: args.organizationId,
    accountId: args.accountId,
    role: args.role,
    status: args.status,
    billable: args.billable,
    invitedByAccountId: args.invitedByAccountId,
    joinedAt: args.status === "active" ? args.now : undefined,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

async function markPendingInvitesAcceptedByEmail(
  ctx: DbCtx,
  args: {
    organizationId: Id<"organizations">;
    email?: string;
    acceptedAt: number;
  },
) {
  if (!args.email) {
    return;
  }

  const normalizedEmail = args.email.toLowerCase();
  const pendingInvites = await ctx.db
    .query("invites")
    .withIndex("by_org_email_status", (q) =>
      q.eq("organizationId", args.organizationId).eq("email", normalizedEmail).eq("status", "pending"),
    )
    .collect();

  for (const invite of pendingInvites) {
    await ctx.db.patch(invite._id, {
      status: "accepted",
      acceptedAt: args.acceptedAt,
      updatedAt: args.acceptedAt,
    });
  }
}

async function ensurePersonalWorkspace(
  ctx: DbCtx,
  accountId: Id<"accounts">,
  opts: { email: string; firstName?: string; workosUserId: string; now: number; workspaceName?: string },
) {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();

  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace && workspace.createdByAccountId === accountId) {
      await upsertOrganizationMembership(ctx, {
        organizationId: workspace.organizationId,
        accountId,
        role: "owner",
        status: "active",
        billable: true,
        now: opts.now,
      });
      const refreshedWorkspace = await ctx.db.get(workspace._id);
      return { workspace: refreshedWorkspace, membership };
    }
  }

  const workspaceName = opts.workspaceName ?? `${opts.firstName ?? "My"}'s Workspace`;
  const organizationSlug = await ensureUniqueOrganizationSlug(ctx, workspaceName);
  const organizationId = await ctx.db.insert("organizations", {
    slug: organizationSlug,
    name: workspaceName,
    status: "active",
    createdByAccountId: accountId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  const baseSlug = slugify(opts.email.split("@")[0] ?? opts.workosUserId);
  const workspaceId = await ctx.db.insert("workspaces", {
    organizationId,
    slug: `${baseSlug}-${opts.workosUserId.slice(-6)}`,
    name: workspaceName,
    plan: "free",
    createdByAccountId: accountId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  await upsertOrganizationMembership(ctx, {
    organizationId,
    accountId,
    role: "owner",
    status: "active",
    billable: true,
    now: opts.now,
  });

  const userId = await ctx.db.insert("workspaceMembers", {
    workspaceId,
    accountId,
    role: "owner",
    status: "active",
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  return {
    workspace: await ctx.db.get(workspaceId),
    membership: await ctx.db.get(userId),
  };
}

function getIdentityString(identity: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

async function getAuthKitUserProfile(ctx: RunQueryCtx, workosUserId: string) {
  try {
    return await ctx.runQuery(components.workOSAuthKit.lib.getAuthUser, {
      id: workosUserId,
    });
  } catch {
    return null;
  }
}

const workosEventHandlers = {
  "user.created": async (ctx, event) => {
    const now = Date.now();
    const data = event.data;
    const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.email;

    let account = await getAccountByWorkosId(ctx, data.id);
    if (account) {
      await ctx.db.patch(account._id, {
        email: data.email,
        name: fullName,
        firstName: data.firstName ?? undefined,
        lastName: data.lastName ?? undefined,
        avatarUrl: data.profilePictureUrl ?? undefined,
        status: "active",
        updatedAt: now,
        lastLoginAt: now,
      });
      account = await ctx.db.get(account._id);
    } else {
      const accountId = await ctx.db.insert("accounts", {
        provider: "workos",
        providerAccountId: data.id,
        email: data.email,
        name: fullName,
        firstName: data.firstName ?? undefined,
        lastName: data.lastName ?? undefined,
        avatarUrl: data.profilePictureUrl ?? undefined,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
      account = await ctx.db.get(accountId);
    }

    if (!account) return;
    await ensurePersonalWorkspace(ctx, account._id, {
      email: data.email,
      firstName: data.firstName ?? undefined,
      workosUserId: data.id,
      now,
    });
  },

  "user.updated": async (ctx, event) => {
    const account = await getAccountByWorkosId(ctx, event.data.id);
    if (!account) return;

    const fullName = [event.data.firstName, event.data.lastName].filter(Boolean).join(" ") || event.data.email;
    await ctx.db.patch(account._id, {
      email: event.data.email,
      name: fullName,
      firstName: event.data.firstName ?? undefined,
      lastName: event.data.lastName ?? undefined,
      avatarUrl: event.data.profilePictureUrl ?? undefined,
      status: "active",
      updatedAt: Date.now(),
    });
  },

  "user.deleted": async (ctx, event) => {
    const account = await getAccountByWorkosId(ctx, event.data.id);
    if (!account) return;

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
    }

    await ctx.db.delete(account._id);
  },

  "organization.created": async (ctx, event) => {
    const now = Date.now();
    let organization = await getOrganizationByWorkosOrgId(ctx, event.data.id);
    if (organization) {
      await ctx.db.patch(organization._id, {
        name: event.data.name,
        status: "active",
        updatedAt: now,
      });
      organization = await ctx.db.get(organization._id);
    } else {
      const slug = await ensureUniqueOrganizationSlug(ctx, event.data.name);
      const organizationId = await ctx.db.insert("organizations", {
        workosOrgId: event.data.id,
        slug,
        name: event.data.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      organization = await ctx.db.get(organizationId);
    }

    if (!organization) {
      return;
    }

    const existingWorkspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (existingWorkspace) {
      await ctx.db.patch(existingWorkspace._id, {
        organizationId: organization._id,
        name: event.data.name,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("workspaces", {
      workosOrgId: event.data.id,
      organizationId: organization._id,
      slug: `${slugify(event.data.name)}-${event.data.id.slice(-6)}`,
      name: event.data.name,
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization.updated": async (ctx, event) => {
    const organization = await getOrganizationByWorkosOrgId(ctx, event.data.id);
    if (organization) {
      await ctx.db.patch(organization._id, {
        name: event.data.name,
        updatedAt: Date.now(),
      });
    }

    const workspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (!workspace) return;
    await ctx.db.patch(workspace._id, {
      organizationId: workspace.organizationId,
      name: event.data.name,
      updatedAt: Date.now(),
    });
  },

  "organization.deleted": async (ctx, event) => {
    const organization = await getOrganizationByWorkosOrgId(ctx, event.data.id);
    if (organization) {
      await ctx.db.patch(organization._id, {
        status: "deleted",
        updatedAt: Date.now(),
      });
    }

    const workspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (!workspace) return;

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    for (const member of members) {
      await ctx.db.delete(member._id);
    }

    await ctx.db.delete(workspace._id);
  },

  "organization_membership.created": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as {
      id: string;
      user_id?: string;
      userId?: string;
      organization_id?: string;
      organizationId?: string;
      role?: { slug?: string };
      status?: string;
    };
    const workosUserId = data.user_id ?? data.userId;
    const workosOrgId = data.organization_id ?? data.organizationId;
    if (!workosUserId || !workosOrgId) return;

    const [account, workspace] = await Promise.all([
      getAccountByWorkosId(ctx, workosUserId),
      getWorkspaceByWorkosOrgId(ctx, workosOrgId),
    ]);
    if (!account || !workspace) return;

    const organizationId = workspace.organizationId;

    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspace._id).eq("accountId", account._id))
      .unique();

    const workosRole = data.role?.slug ?? "member";
    const role = workosRole === "admin" ? "admin" : "member";
    const status = data.status === "active" ? "active" : "pending";

    await upsertOrganizationMembership(ctx, {
      organizationId,
      accountId: account._id,
      role,
      status,
      billable: status === "active",
      now,
    });

    if (status === "active") {
      await markPendingInvitesAcceptedByEmail(ctx, {
        organizationId,
        email: account.email,
        acceptedAt: now,
      });
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        workosOrgMembershipId: event.data.id,
        role,
        status,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("workspaceMembers", {
      workspaceId: workspace._id,
      accountId: account._id,
      workosOrgMembershipId: event.data.id,
      role,
      status,
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization_membership.updated": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as {
      id: string;
      user_id?: string;
      userId?: string;
      organization_id?: string;
      organizationId?: string;
      role?: { slug?: string };
      status?: string;
    };

    let membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workos_membership_id", (q) => q.eq("workosOrgMembershipId", data.id))
      .unique();

    let account: Doc<"accounts"> | null = null;
    let workspace: Doc<"workspaces"> | null = null;

    if (!membership) {
      const workosUserId = data.user_id ?? data.userId;
      const workosOrgId = data.organization_id ?? data.organizationId;
      if (!workosUserId || !workosOrgId) return;
      [account, workspace] = await Promise.all([
        getAccountByWorkosId(ctx, workosUserId),
        getWorkspaceByWorkosOrgId(ctx, workosOrgId),
      ]);
      if (!account || !workspace) return;
      const workspaceId = workspace._id;
      const accountId = account._id;
      membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspaceId).eq("accountId", accountId))
        .unique();
      if (!membership) return;
    } else {
      account = await ctx.db.get(membership.accountId);
      workspace = await ctx.db.get(membership.workspaceId);
    }

    if (!account || !workspace) {
      return;
    }

    const organizationId = workspace.organizationId;

    const workosRole = data.role?.slug ?? "member";
    const status = data.status === "active" ? "active" : "pending";
    await upsertOrganizationMembership(ctx, {
      organizationId,
      accountId: account._id,
      role: workosRole === "admin" ? "admin" : "member",
      status,
      billable: status === "active",
      now,
    });

    if (status === "active") {
      await markPendingInvitesAcceptedByEmail(ctx, {
        organizationId,
        email: account.email,
        acceptedAt: now,
      });
    }

    await ctx.db.patch(membership._id, {
      workosOrgMembershipId: data.id,
      role: workosRole === "admin" ? "admin" : "member",
      status,
      updatedAt: now,
    });
  },

  "organization_membership.deleted": async (ctx, event) => {
    const now = Date.now();
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workos_membership_id", (q) => q.eq("workosOrgMembershipId", event.data.id))
      .unique();
    if (!membership) return;

    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace?.organizationId) {
      await upsertOrganizationMembership(ctx, {
        organizationId: workspace.organizationId,
        accountId: membership.accountId,
        role: membership.role,
        status: "removed",
        billable: false,
        now,
      });
    }

    await ctx.db.delete(membership._id);
  },
} satisfies Partial<Parameters<AuthKit<DataModel>["events"]>[0]>;

const authKitEvents = workosEnabled && authKitInstance
  ? authKitInstance.events(workosEventHandlers)
  : null;

export const authKitEvent = authKitEvents?.authKitEvent ?? internalMutation({
  args: {},
  handler: async () => null,
});

export const bootstrapCurrentWorkosAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const now = Date.now();
    const identityRecord = identity as Record<string, unknown>;
    const subject = identity.subject;
    const authKitProfile = await getAuthKitUserProfile(ctx, subject);
    const email =
      authKitProfile?.email
      ??
      getIdentityString(identityRecord, [
        "email",
        "https://workos.com/email",
        "upn",
      ]) ?? `${subject}@workos.executor.local`;

    const firstName =
      authKitProfile?.firstName
      ?? getIdentityString(identityRecord, [
        "given_name",
        "first_name",
        "https://workos.com/first_name",
      ]);
    const lastName =
      authKitProfile?.lastName
      ?? getIdentityString(identityRecord, [
        "family_name",
        "last_name",
        "https://workos.com/last_name",
      ]);
    const fullName =
      (getIdentityString(identityRecord, [
        "name",
        "https://workos.com/name",
      ]) ?? [firstName, lastName].filter(Boolean).join(" "))
      || email;
    const avatarUrl =
      (authKitProfile?.profilePictureUrl ?? undefined)
      ?? getIdentityString(identityRecord, [
        "picture",
        "avatar_url",
        "https://workos.com/profile_picture_url",
      ]);

    let account = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) => q.eq("provider", "workos").eq("providerAccountId", subject))
      .unique();

    if (account) {
      await ctx.db.patch(account._id, {
        email,
        name: fullName,
        firstName,
        lastName,
        avatarUrl,
        status: "active",
        updatedAt: now,
        lastLoginAt: now,
      });
      account = await ctx.db.get(account._id);
    } else {
      const accountId = await ctx.db.insert("accounts", {
        provider: "workos",
        providerAccountId: subject,
        email,
        name: fullName,
        firstName,
        lastName,
        avatarUrl,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
      account = await ctx.db.get(accountId);
    }

    if (!account) return null;

    await ensurePersonalWorkspace(ctx, account._id, {
      email,
      firstName,
      workosUserId: subject,
      now,
      workspaceName: `${firstName ?? "My"}'s Workspace`,
    });

    return account;
  },
});
