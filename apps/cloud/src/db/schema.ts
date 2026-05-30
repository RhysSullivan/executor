// ---------------------------------------------------------------------------
// Cloud-specific identity & multi-tenancy tables
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical user/membership data. We mirror minimally:
//
//   - `accounts`       — login identity (foreign key anchor for created_by, etc.)
//   - `organizations`  — billing entity, scoping root for all domain data
//   - `memberships`    — which accounts belong to which organizations
//
// We do NOT mirror invitations or user profile data — those stay in WorkOS
// and are queried via API when needed.

import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Login identity. The `id` is the WorkOS user ID. */
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Organization (billing entity, scoping root). The `id` is the WorkOS organization ID. */
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Account ↔ organization link. Lets us answer "which workspaces does this
 * account belong to?" without a WorkOS round-trip, and gives future
 * per-(account, organization) data a foreign key to point at.
 */
export const memberships = pgTable(
  "memberships",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountId, t.organizationId] }),
  }),
);
