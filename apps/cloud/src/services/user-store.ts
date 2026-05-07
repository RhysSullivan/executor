// ---------------------------------------------------------------------------
// Account & Organization storage — minimal mirror of WorkOS data
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical data for users, organizations, memberships,
// and invitations. We keep tiny local mirrors of accounts and organizations
// so domain tables can foreign-key against them and so we can resolve org
// metadata without an API call on every request.

import { eq, like } from "drizzle-orm";

import { slugifyHandle, withHandleSuffix } from "./ids";
import { accounts, organizations } from "./schema";
import type { DrizzleDb } from "./db";

export type Account = typeof accounts.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

/**
 * Pick a unique org handle starting from `base`. Prefers `base`, then
 * `base-2`, `base-3`, … This races safely enough for cloud's volume —
 * the unique constraint catches truly concurrent collisions and the
 * caller should surface that as a retryable error.
 */
export const pickFreeOrgHandle = async (db: DrizzleDb, base: string): Promise<string> => {
  const existing = await db
    .select({ handle: organizations.handle })
    .from(organizations)
    .where(like(organizations.handle, `${base}%`));
  const taken = new Set(existing.map((r) => r.handle));
  if (!taken.has(base)) return base;
  for (let n = 2; n < taken.size + 2; n++) {
    const candidate = withHandleSuffix(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  // Defensive — in practice unreachable because the loop scans n up to
  // taken.size + 2, which dominates any prefix-collision count.
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: invariant on a Promise-returning helper
  throw new Error(`could not allocate free handle for base "${base}"`);
};

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
    const existing = await db.select().from(organizations).where(eq(organizations.id, org.id));
    if (existing[0]) {
      const [updated] = await db
        .update(organizations)
        .set({ name: org.name })
        .where(eq(organizations.id, org.id))
        .returning();
      return updated!;
    }
    const handle = await pickFreeOrgHandle(db, slugifyHandle(org.name));
    const [inserted] = await db
      .insert(organizations)
      .values({ id: org.id, name: org.name, handle })
      .returning();
    return inserted!;
  },

  getOrganization: async (id: string) => {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id));
    return rows[0] ?? null;
  },

  getOrganizationByHandle: async (handle: string) => {
    const rows = await db.select().from(organizations).where(eq(organizations.handle, handle));
    return rows[0] ?? null;
  },
});
