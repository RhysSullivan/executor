// ---------------------------------------------------------------------------
// Account & Organization storage — minimal mirror of WorkOS data
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical data for users, organizations, memberships,
// and invitations. We keep tiny local mirrors of accounts and organizations
// so domain tables can foreign-key against them and so we can resolve org
// metadata without an API call on every request.

import { and, eq } from "drizzle-orm";

import {
  accounts,
  identitySyncCursors,
  identitySyncEvents,
  memberships,
  organizations,
} from "./schema";
import type { DrizzleDb } from "./db";

export type Account = typeof accounts.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;

export type AccountInput = {
  readonly id: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly avatarUrl?: string | null;
  readonly externalId?: string | null;
  readonly identityProvider?: string;
};

export type OrganizationInput = {
  readonly id: string;
  readonly name: string;
  readonly externalId?: string | null;
  readonly identityProvider?: string;
};

export type MembershipInput = {
  readonly accountId: string;
  readonly organizationId: string;
  readonly externalId?: string | null;
  readonly identityProvider?: string;
  readonly status?: string;
  readonly roleSlug?: string;
};

export const makeUserStore = (db: DrizzleDb) => ({
  // --- Accounts ---

  ensureAccount: async (idOrAccount: string | AccountInput) => {
    const account = typeof idOrAccount === "string" ? { id: idOrAccount } : idOrAccount;
    const [result] = await db
      .insert(accounts)
      .values({
        id: account.id,
        email: account.email ?? null,
        name: account.name ?? null,
        avatarUrl: account.avatarUrl ?? null,
        externalId: account.externalId ?? account.id,
        identityProvider: account.identityProvider ?? "workos",
      })
      .onConflictDoUpdate({
        target: accounts.id,
        set: {
          email: account.email ?? null,
          name: account.name ?? null,
          avatarUrl: account.avatarUrl ?? null,
          externalId: account.externalId ?? account.id,
          identityProvider: account.identityProvider ?? "workos",
          updatedAt: new Date(),
        },
      })
      .returning();
    return result ?? (await db.select().from(accounts).where(eq(accounts.id, account.id)))[0]!;
  },

  getAccount: async (id: string) => {
    const rows = await db.select().from(accounts).where(eq(accounts.id, id));
    return rows[0] ?? null;
  },

  // --- Organizations ---

  upsertOrganization: async (org: OrganizationInput) => {
    const [result] = await db
      .insert(organizations)
      .values({
        id: org.id,
        name: org.name,
        externalId: org.externalId ?? org.id,
        identityProvider: org.identityProvider ?? "workos",
      })
      .onConflictDoUpdate({
        target: organizations.id,
        set: {
          name: org.name,
          externalId: org.externalId ?? org.id,
          identityProvider: org.identityProvider ?? "workos",
          updatedAt: new Date(),
        },
      })
      .returning();
    return result!;
  },

  getOrganization: async (id: string) => {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id));
    return rows[0] ?? null;
  },

  // --- Memberships ---

  upsertMembership: async (membership: MembershipInput) => {
    const now = new Date();
    const values = {
      accountId: membership.accountId,
      organizationId: membership.organizationId,
      externalId: membership.externalId ?? `${membership.accountId}:${membership.organizationId}`,
      identityProvider: membership.identityProvider ?? "workos",
      status: membership.status ?? "active",
      roleSlug: membership.roleSlug ?? "member",
      updatedAt: now,
      syncedAt: now,
    };
    const [result] = await db
      .insert(memberships)
      .values(values)
      .onConflictDoUpdate({
        target: [memberships.accountId, memberships.organizationId],
        set: {
          externalId: values.externalId,
          identityProvider: values.identityProvider,
          status: values.status,
          roleSlug: values.roleSlug,
          updatedAt: now,
          syncedAt: now,
        },
      })
      .returning();
    return result!;
  },

  getMembership: async (accountId: string, organizationId: string) => {
    const rows = await db
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.accountId, accountId), eq(memberships.organizationId, organizationId)),
      );
    return rows[0] ?? null;
  },

  listMembershipsForAccount: async (accountId: string) =>
    db.select().from(memberships).where(eq(memberships.accountId, accountId)),

  listMembershipsForOrganization: async (organizationId: string) =>
    db.select().from(memberships).where(eq(memberships.organizationId, organizationId)),

  deactivateMembership: async (accountId: string, organizationId: string) => {
    const [result] = await db
      .update(memberships)
      .set({ status: "inactive", updatedAt: new Date(), syncedAt: new Date() })
      .where(
        and(eq(memberships.accountId, accountId), eq(memberships.organizationId, organizationId)),
      )
      .returning();
    return result ?? null;
  },

  recordIdentityEvent: async (event: {
    provider: string;
    eventId: string;
    eventType: string;
  }) => {
    const [result] = await db
      .insert(identitySyncEvents)
      .values(event)
      .onConflictDoNothing()
      .returning();
    return result != null;
  },

  getIdentityCursor: async (provider: string) => {
    const rows = await db
      .select()
      .from(identitySyncCursors)
      .where(eq(identitySyncCursors.provider, provider));
    return rows[0]?.cursor ?? null;
  },

  setIdentityCursor: async (provider: string, cursor: string | null) => {
    const [result] = await db
      .insert(identitySyncCursors)
      .values({ provider, cursor })
      .onConflictDoUpdate({
        target: identitySyncCursors.provider,
        set: { cursor, updatedAt: new Date() },
      })
      .returning();
    return result!;
  },
});
