import { Migrations } from "@convex-dev/migrations";
import type { Id } from "./_generated/dataModel";
import type { DataModel } from "./_generated/dataModel";
import { components } from "./_generated/api";

const migrations = new Migrations<DataModel>(components.migrations);

const LEGACY_GUEST_NAME = "Guest Workspace";
const ANONYMOUS_ORGANIZATION_NAME = "Anonymous Organization";
const ANONYMOUS_WORKSPACE_NAME = "Anonymous Workspace";

async function isAnonymousCreator(
  ctx: { db: { get: (id: Id<"accounts">) => Promise<{ provider: string } | null> } },
  accountId: Id<"accounts"> | undefined,
): Promise<boolean> {
  if (!accountId) {
    return false;
  }

  const account = await ctx.db.get(accountId);
  return account?.provider === "anonymous";
}

export const renameLegacyAnonymousOrganizations = migrations.define({
  table: "organizations",
  migrateOne: async (ctx, organization) => {
    if (organization.name !== LEGACY_GUEST_NAME) {
      return;
    }

    const anonymousCreator = await isAnonymousCreator(ctx, organization.createdByAccountId);
    if (!anonymousCreator) {
      return;
    }

    return {
      name: ANONYMOUS_ORGANIZATION_NAME,
      updatedAt: Date.now(),
    };
  },
});

export const renameLegacyAnonymousWorkspaces = migrations.define({
  table: "workspaces",
  migrateOne: async (ctx, workspace) => {
    if (workspace.name !== LEGACY_GUEST_NAME) {
      return;
    }

    const anonymousCreator = await isAnonymousCreator(ctx, workspace.createdByAccountId);
    if (!anonymousCreator) {
      return;
    }

    return {
      name: ANONYMOUS_WORKSPACE_NAME,
      updatedAt: Date.now(),
    };
  },
});

export const deleteAnonymousSessionsMissingAccountId = migrations.define({
  table: "anonymousSessions",
  migrateOne: async (ctx, session) => {
    if (session.accountId) {
      return;
    }

    await ctx.db.delete(session._id);
  },
});

export const deleteSourceCredentialsMissingProvider = migrations.define({
  table: "sourceCredentials",
  migrateOne: async (ctx, credential) => {
    if (credential.provider) {
      return;
    }

    await ctx.db.delete(credential._id);
  },
});

export const deleteInvitesMissingProvider = migrations.define({
  table: "invites",
  migrateOne: async (ctx, invite) => {
    if (invite.provider) {
      return;
    }

    await ctx.db.delete(invite._id);
  },
});

export const deleteAnonymousSessionsMissingUserId = migrations.define({
  table: "anonymousSessions",
  migrateOne: async (ctx, session) => {
    if (session.userId) {
      return;
    }

    await ctx.db.delete(session._id);
  },
});

export const backfillDtsStorageIds = migrations.define({
  table: "workspaceToolCache",
  migrateOne: async (_ctx, entry) => {
    if (entry.dtsStorageIds === undefined) {
      return { dtsStorageIds: [] };
    }
  },
});

export const run = migrations.runner();
