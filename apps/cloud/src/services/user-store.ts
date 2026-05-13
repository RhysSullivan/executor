// ---------------------------------------------------------------------------
// Account & Organization storage — minimal mirror of WorkOS data
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical data for users, organizations, memberships,
// and invitations. We keep tiny local mirrors of accounts and organizations
// so domain tables can foreign-key against them and so we can resolve org
// metadata without an API call on every request.

import { eq } from "drizzle-orm";

import { accounts, organizations } from "./schema";
import type { DrizzleDb } from "./db";

export type Account = typeof accounts.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

export const makeUserStore = (db: DrizzleDb) => ({
  // --- Accounts ---

  ensureAccount: async (id: string) => {
    const [result] = await db.insert(accounts).values({ id }).onConflictDoNothing().returning();
    return result ?? (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!;
  },

  getAccount: async (id: string) => {
    const rows = await db.select().from(accounts).where(eq(accounts.id, id));
    return rows[0] ?? null;
  },

  // --- Organizations ---

  upsertOrganization: async (org: { id: string; name: string }) => {
    const [result] = await db
      .insert(organizations)
      .values(org)
      .onConflictDoUpdate({
        target: organizations.id,
        set: { name: org.name },
      })
      .returning();
    return result!;
  },

  getOrganization: async (id: string) => {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id));
    return rows[0] ?? null;
  },
});
