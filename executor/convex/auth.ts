import { AuthKit, type AuthFunctions } from "@convex-dev/workos-authkit";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";

const workosEnabled = Boolean(
  process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY && process.env.WORKOS_WEBHOOK_SECRET,
);

const authFunctions = (internal as any).auth as AuthFunctions;

const authKitInstance = workosEnabled
  ? new AuthKit<DataModel>((components as any).workOSAuthKit, {
      authFunctions,
      additionalEventTypes: [
        "organization.created",
        "organization.updated",
        "organization.deleted",
        "organization_membership.created",
        "organization_membership.updated",
        "organization_membership.deleted",
        "session.created",
        "session.revoked",
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

async function getAccountByWorkosId(ctx: { db: any }, workosUserId: string) {
  return await ctx.db
    .query("accounts")
    .withIndex("by_provider", (q: any) => q.eq("provider", "workos").eq("providerAccountId", workosUserId))
    .unique();
}

async function getWorkspaceByWorkosOrgId(ctx: { db: any }, workosOrgId: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_workos_org_id", (q: any) => q.eq("workosOrgId", workosOrgId))
    .unique();
}

async function ensurePersonalWorkspace(
  ctx: { db: any },
  accountId: Id<"accounts">,
  opts: { email: string; firstName?: string; workosUserId: string; now: number; workspaceName?: string },
) {
  const memberships = await ctx.db
    .query("users")
    .withIndex("by_account", (q: any) => q.eq("accountId", accountId))
    .collect();

  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace?.kind === "personal") {
      return { workspace, membership };
    }
  }

  const baseSlug = slugify(opts.email.split("@")[0] ?? opts.workosUserId);
  const workspaceId = await ctx.db.insert("workspaces", {
    legacyWorkspaceId: `ws_${crypto.randomUUID()}`,
    slug: `${baseSlug}-${opts.workosUserId.slice(-6)}`,
    name: opts.workspaceName ?? `${opts.firstName ?? "My"}'s Workspace`,
    kind: "personal",
    plan: "free",
    createdByAccountId: accountId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  const userId = await ctx.db.insert("users", {
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
      .query("users")
      .withIndex("by_account", (q: any) => q.eq("accountId", account._id))
      .collect();
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
    }

    const sessions = await ctx.db
      .query("accountSessions")
      .withIndex("by_account_created", (q: any) => q.eq("accountId", account._id))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    await ctx.db.delete(account._id);
  },

  "organization.created": async (ctx, event) => {
    const now = Date.now();
    const existing = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: event.data.name,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("workspaces", {
      workosOrgId: event.data.id,
      legacyWorkspaceId: `ws_org_${event.data.id}`,
      slug: `${slugify(event.data.name)}-${event.data.id.slice(-6)}`,
      name: event.data.name,
      kind: "organization",
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization.updated": async (ctx, event) => {
    const workspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (!workspace) return;
    await ctx.db.patch(workspace._id, {
      name: event.data.name,
      updatedAt: Date.now(),
    });
  },

  "organization.deleted": async (ctx, event) => {
    const workspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (!workspace) return;

    const members = await ctx.db
      .query("users")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspace._id))
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

    const existing = await ctx.db
      .query("users")
      .withIndex("by_workspace_account", (q: any) => q.eq("workspaceId", workspace._id).eq("accountId", account._id))
      .unique();

    const workosRole = data.role?.slug ?? "member";
    const role = workosRole === "admin" ? "admin" : "member";
    const status = data.status === "active" ? "active" : "pending";

    if (existing) {
      await ctx.db.patch(existing._id, {
        workosOrgMembershipId: event.data.id,
        role,
        status,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("users", {
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
      .query("users")
      .withIndex("by_workos_membership_id", (q: any) => q.eq("workosOrgMembershipId", data.id))
      .unique();

    if (!membership) {
      const workosUserId = data.user_id ?? data.userId;
      const workosOrgId = data.organization_id ?? data.organizationId;
      if (!workosUserId || !workosOrgId) return;
      const [account, workspace] = await Promise.all([
        getAccountByWorkosId(ctx, workosUserId),
        getWorkspaceByWorkosOrgId(ctx, workosOrgId),
      ]);
      if (!account || !workspace) return;
      membership = await ctx.db
        .query("users")
        .withIndex("by_workspace_account", (q: any) => q.eq("workspaceId", workspace._id).eq("accountId", account._id))
        .unique();
      if (!membership) return;
    }

    const workosRole = data.role?.slug ?? "member";
    await ctx.db.patch(membership._id, {
      workosOrgMembershipId: data.id,
      role: workosRole === "admin" ? "admin" : "member",
      status: data.status === "active" ? "active" : "pending",
      updatedAt: now,
    });
  },

  "organization_membership.deleted": async (ctx, event) => {
    const membership = await ctx.db
      .query("users")
      .withIndex("by_workos_membership_id", (q: any) => q.eq("workosOrgMembershipId", event.data.id))
      .unique();
    if (!membership) return;
    await ctx.db.delete(membership._id);
  },

  "session.created": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as {
      id?: string;
      user_id?: string;
      userId?: string;
      expires_at?: string;
      expiresAt?: string;
    };
    const workosUserId = data.user_id ?? data.userId;
    if (!workosUserId || !data.id) return;

    const account = await getAccountByWorkosId(ctx, workosUserId);
    if (!account) return;

    const existing = await ctx.db
      .query("accountSessions")
      .withIndex("by_provider_session_id", (q: any) => q.eq("providerSessionId", data.id))
      .unique();

    const expiresAtRaw = data.expires_at ?? data.expiresAt;
    const expiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : undefined;

    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: account._id,
        expiresAt: Number.isNaN(expiresAt) ? undefined : expiresAt,
        lastSeenAt: now,
        revokedAt: undefined,
      });
      return;
    }

    await ctx.db.insert("accountSessions", {
      accountId: account._id,
      providerSessionId: data.id,
      issuedAt: now,
      expiresAt: Number.isNaN(expiresAt) ? undefined : expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });
  },

  "session.revoked": async (ctx, event) => {
    const data = event.data as { id?: string };
    if (!data.id) return;

    const existing = await ctx.db
      .query("accountSessions")
      .withIndex("by_provider_session_id", (q: any) => q.eq("providerSessionId", data.id))
      .unique();
    if (!existing) return;

    await ctx.db.patch(existing._id, {
      revokedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
  },
};

export const authKitEvent =
  workosEnabled && authKitInstance
    ? (authKitInstance.events(workosEventHandlers as any) as any).authKitEvent
    : internalMutation({
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
    const email =
      getIdentityString(identityRecord, [
        "email",
        "https://workos.com/email",
        "upn",
      ]) ?? `${subject}@workos.executor.local`;

    const firstName = getIdentityString(identityRecord, [
      "given_name",
      "first_name",
      "https://workos.com/first_name",
    ]);
    const lastName = getIdentityString(identityRecord, [
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

    const sessionSuffix = getIdentityString(identityRecord, [
      "sid",
      "session_id",
      "https://workos.com/session_id",
    ]);
    const fallbackSessionId = `workos_${subject}_${now}`;
    const sessionId = sessionSuffix ? `workos_${sessionSuffix}` : fallbackSessionId;

    const existingSession = await ctx.db
      .query("accountSessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
      .unique();

    if (existingSession) {
      await ctx.db.patch(existingSession._id, {
        accountId: account._id,
        lastSeenAt: now,
        revokedAt: undefined,
      });
    } else {
      await ctx.db.insert("accountSessions", {
        accountId: account._id,
        sessionId,
        createdAt: now,
        lastSeenAt: now,
      });
    }

    return account;
  },
});

export const createWorkspace = mutation({
  args: {
    name: v.string(),
    iconStorageId: v.optional(v.id("_storage")),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) {
      throw new Error("Must be signed in to create a workspace");
    }

    const trimmedName = args.name.trim();
    if (trimmedName.length < 2) {
      throw new Error("Workspace name must be at least 2 characters");
    }

    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: `${slugify(trimmedName)}-${crypto.randomUUID().slice(0, 6)}`,
      name: trimmedName,
      iconStorageId: args.iconStorageId,
      kind: "personal",
      plan: "free",
      legacyWorkspaceId: `ws_${crypto.randomUUID()}`,
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    const userId = await ctx.db.insert("users", {
      workspaceId,
      accountId: account._id,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const [workspace, user] = await Promise.all([
      ctx.db.get(workspaceId),
      ctx.db.get(userId),
    ]);
    if (!workspace || !user) {
      throw new Error("Failed to create workspace");
    }

    const iconUrl = workspace.iconStorageId
      ? await ctx.storage.getUrl(workspace.iconStorageId)
      : null;

    return {
      ...workspace,
      iconUrl,
      userId: user._id,
      role: user.role,
      status: user.status,
      runtimeWorkspaceId: workspace.legacyWorkspaceId ?? `ws_${String(workspace._id)}`,
    };
  },
});

export const generateWorkspaceIconUploadUrl = mutation({
  args: {
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) {
      throw new Error("Must be signed in to upload workspace icons");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

async function resolveAccountForRequest(ctx: { auth: any; db: any }, sessionId?: string): Promise<Doc<"accounts"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    return await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q: any) => q.eq("provider", "workos").eq("providerAccountId", identity.subject))
      .unique();
  }

  if (!sessionId) return null;
  const anon = await ctx.db
    .query("anonymousSessions")
    .withIndex("by_session_id", (q: any) => q.eq("sessionId", sessionId))
    .unique();
  if (!anon?.accountId) return null;
  return await ctx.db.get(anon.accountId);
}

export const getCurrentAccount = query({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await resolveAccountForRequest(ctx, args.sessionId);
  },
});

export const getMyWorkspaces = query({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) return [];

    const memberships = await ctx.db
      .query("users")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();

    const workspaces = await Promise.all(
      memberships
        .filter((membership) => membership.status === "active")
        .map(async (membership) => {
          const workspace = await ctx.db.get(membership.workspaceId);
          if (!workspace) return null;
          const iconUrl = workspace.iconStorageId
            ? await ctx.storage.getUrl(workspace.iconStorageId)
            : null;
          return {
            ...workspace,
            iconUrl,
            userId: membership._id,
            role: membership.role,
            status: membership.status,
            runtimeWorkspaceId: workspace.legacyWorkspaceId ?? `ws_${String(workspace._id)}`,
          };
        }),
    );

    return workspaces.filter((workspace): workspace is NonNullable<typeof workspace> => workspace !== null);
  },
});

export const getMyAccountsWithWorkspaces = query({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) return [];

    const memberships = await ctx.db
      .query("users")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();

    const workspaces = await Promise.all(
      memberships
        .filter((membership) => membership.status === "active")
        .map(async (membership) => {
          const workspace = await ctx.db.get(membership.workspaceId);
          if (!workspace) return null;
          const iconUrl = workspace.iconStorageId
            ? await ctx.storage.getUrl(workspace.iconStorageId)
            : null;
          return {
            ...workspace,
            iconUrl,
            userId: membership._id,
            role: membership.role,
            status: membership.status,
            runtimeWorkspaceId: workspace.legacyWorkspaceId ?? `ws_${String(workspace._id)}`,
          };
        }),
    );

    return [
      {
        account,
        workspaces: workspaces.filter((workspace): workspace is NonNullable<typeof workspace> => workspace !== null),
      },
    ];
  },
});
