import {
  type OrganizationMembership,
  OrganizationMembershipSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, asc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption, withoutCreatedAt } from "./shared";

const decodeOrganizationMembership = Schema.decodeUnknownSync(
  OrganizationMembershipSchema,
);

export const createOrganizationMembershipsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByOrganizationId: (
    organizationId: OrganizationMembership["organizationId"],
  ) =>
    client.use("rows.organization_memberships.list_by_organization", async (db) => {
      const rows = await db
        .select()
        .from(tables.organizationMembershipsTable)
        .where(eq(tables.organizationMembershipsTable.organizationId, organizationId))
        .orderBy(
          asc(tables.organizationMembershipsTable.updatedAt),
          asc(tables.organizationMembershipsTable.id),
        );

      return rows.map((row) => decodeOrganizationMembership(row));
    }),

  listByAccountId: (accountId: OrganizationMembership["accountId"]) =>
    client.use("rows.organization_memberships.list_by_account", async (db) => {
      const rows = await db
        .select()
        .from(tables.organizationMembershipsTable)
        .where(eq(tables.organizationMembershipsTable.accountId, accountId))
        .orderBy(
          asc(tables.organizationMembershipsTable.updatedAt),
          asc(tables.organizationMembershipsTable.id),
        );

      return rows.map((row) => decodeOrganizationMembership(row));
    }),

  getByOrganizationAndAccount: (
    organizationId: OrganizationMembership["organizationId"],
    accountId: OrganizationMembership["accountId"],
  ) =>
    client.use(
      "rows.organization_memberships.get_by_organization_and_account",
      async (db) => {
        const rows = await db
          .select()
          .from(tables.organizationMembershipsTable)
          .where(
            and(
              eq(tables.organizationMembershipsTable.organizationId, organizationId),
              eq(tables.organizationMembershipsTable.accountId, accountId),
            ),
          )
          .limit(1);

        const row = firstOption(rows);
        return Option.isSome(row)
          ? Option.some(decodeOrganizationMembership(row.value))
          : Option.none<OrganizationMembership>();
      },
    ),

  upsert: (membership: OrganizationMembership) =>
    client.use("rows.organization_memberships.upsert", async (db) => {
      await db
        .insert(tables.organizationMembershipsTable)
        .values(membership)
        .onConflictDoUpdate({
          target: [
            tables.organizationMembershipsTable.organizationId,
            tables.organizationMembershipsTable.accountId,
          ],
          set: {
            ...withoutCreatedAt(membership),
            id: membership.id,
          },
        });
    }),

  removeByOrganizationAndAccount: (
    organizationId: OrganizationMembership["organizationId"],
    accountId: OrganizationMembership["accountId"],
  ) =>
    client.use("rows.organization_memberships.remove", async (db) => {
      const deleted = await db
        .delete(tables.organizationMembershipsTable)
        .where(
          and(
            eq(tables.organizationMembershipsTable.organizationId, organizationId),
            eq(tables.organizationMembershipsTable.accountId, accountId),
          ),
        )
        .returning();

      return deleted.length > 0;
    }),
});
