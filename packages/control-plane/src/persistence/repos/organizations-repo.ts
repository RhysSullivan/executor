import {
  type Organization,
  type OrganizationMembership,
  OrganizationMembershipSchema,
  OrganizationSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { asc, eq, inArray } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption, withoutCreatedAt } from "./shared";

const decodeOrganization = Schema.decodeUnknownSync(OrganizationSchema);
const decodeOrganizationMembership = Schema.decodeUnknownSync(
  OrganizationMembershipSchema,
);

export const createOrganizationsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  list: () =>
    client.use("rows.organizations.list", async (db) => {
      const rows = await db
        .select()
        .from(tables.organizationsTable)
        .orderBy(
          asc(tables.organizationsTable.updatedAt),
          asc(tables.organizationsTable.id),
        );

      return rows.map((row) => decodeOrganization(row));
    }),

  getById: (organizationId: Organization["id"]) =>
    client.use("rows.organizations.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.organizationsTable)
        .where(eq(tables.organizationsTable.id, organizationId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeOrganization(row.value))
        : Option.none<Organization>();
    }),

  getBySlug: (slug: Organization["slug"]) =>
    client.use("rows.organizations.get_by_slug", async (db) => {
      const rows = await db
        .select()
        .from(tables.organizationsTable)
        .where(eq(tables.organizationsTable.slug, slug))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeOrganization(row.value))
        : Option.none<Organization>();
    }),

  insert: (organization: Organization) =>
    client.use("rows.organizations.insert", async (db) => {
      await db.insert(tables.organizationsTable).values(organization);
    }),

  insertWithOwnerMembership: (
    organization: Organization,
    ownerMembership: OrganizationMembership | null,
  ) =>
    client.useTx("rows.organizations.insert_with_owner_membership", async (tx) => {
      await tx.insert(tables.organizationsTable).values(organization);

      if (ownerMembership !== null) {
        await tx
          .insert(tables.organizationMembershipsTable)
          .values(decodeOrganizationMembership(ownerMembership))
          .onConflictDoUpdate({
            target: [
              tables.organizationMembershipsTable.organizationId,
              tables.organizationMembershipsTable.accountId,
            ],
            set: {
              ...withoutCreatedAt(ownerMembership),
              id: ownerMembership.id,
            },
          });
      }
    }),

  update: (
    organizationId: Organization["id"],
    patch: Partial<Omit<Organization, "id" | "createdAt">>,
  ) =>
    client.use("rows.organizations.update", async (db) => {
      const rows = await db
        .update(tables.organizationsTable)
        .set(patch)
        .where(eq(tables.organizationsTable.id, organizationId))
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeOrganization(row.value))
        : Option.none<Organization>();
    }),

  removeById: (organizationId: Organization["id"]) =>
    client.use("rows.organizations.remove", async (db) => {
      const deleted = await db
        .delete(tables.organizationsTable)
        .where(eq(tables.organizationsTable.id, organizationId))
        .returning();

      return deleted.length > 0;
    }),

  removeTreeById: (organizationId: Organization["id"]) =>
    client.useTx("rows.organizations.remove_tree", async (tx) => {
      const workspaces = await tx
        .select({ id: tables.workspacesTable.id })
        .from(tables.workspacesTable)
        .where(eq(tables.workspacesTable.organizationId, organizationId));

      const workspaceIds = workspaces.map((workspace) => workspace.id);

      if (workspaceIds.length > 0) {
        const executionRows = await tx
          .select({ id: tables.executionsTable.id })
          .from(tables.executionsTable)
          .where(inArray(tables.executionsTable.workspaceId, workspaceIds));

        const executionIds = executionRows.map((execution) => execution.id);

        if (executionIds.length > 0) {
          await tx
            .delete(tables.executionInteractionsTable)
            .where(
              inArray(tables.executionInteractionsTable.executionId, executionIds),
            );
        }

        await tx
          .delete(tables.executionsTable)
          .where(inArray(tables.executionsTable.workspaceId, workspaceIds));

        await tx
          .delete(tables.sourceCredentialBindingsTable)
          .where(inArray(tables.sourceCredentialBindingsTable.workspaceId, workspaceIds));

        await tx
          .delete(tables.sourcesTable)
          .where(inArray(tables.sourcesTable.workspaceId, workspaceIds));

        await tx
          .delete(tables.policiesTable)
          .where(inArray(tables.policiesTable.workspaceId, workspaceIds));

        await tx
          .delete(tables.workspacesTable)
          .where(inArray(tables.workspacesTable.id, workspaceIds));
      }

      await tx
        .delete(tables.localInstallationsTable)
        .where(eq(tables.localInstallationsTable.organizationId, organizationId));

      await tx
        .delete(tables.organizationMembershipsTable)
        .where(eq(tables.organizationMembershipsTable.organizationId, organizationId));

      const deleted = await tx
        .delete(tables.organizationsTable)
        .where(eq(tables.organizationsTable.id, organizationId))
        .returning();

      return deleted.length > 0;
    }),
});
