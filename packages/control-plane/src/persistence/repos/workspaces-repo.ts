import { type Workspace, WorkspaceSchema } from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { asc, eq, inArray } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeWorkspace = Schema.decodeUnknownSync(WorkspaceSchema);

export const createWorkspacesRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByOrganizationId: (organizationId: Workspace["organizationId"]) =>
    client.use("rows.workspaces.list_by_organization", async (db) => {
      const rows = await db
        .select()
        .from(tables.workspacesTable)
        .where(eq(tables.workspacesTable.organizationId, organizationId))
        .orderBy(
          asc(tables.workspacesTable.updatedAt),
          asc(tables.workspacesTable.id),
        );

      return rows.map((row) => decodeWorkspace(row));
    }),

  getById: (workspaceId: Workspace["id"]) =>
    client.use("rows.workspaces.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.workspacesTable)
        .where(eq(tables.workspacesTable.id, workspaceId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeWorkspace(row.value))
        : Option.none<Workspace>();
    }),

  insert: (workspace: Workspace) =>
    client.use("rows.workspaces.insert", async (db) => {
      await db.insert(tables.workspacesTable).values(workspace);
    }),

  update: (
    workspaceId: Workspace["id"],
    patch: Partial<Omit<Workspace, "id" | "createdAt">>,
  ) =>
    client.use("rows.workspaces.update", async (db) => {
      const rows = await db
        .update(tables.workspacesTable)
        .set(patch)
        .where(eq(tables.workspacesTable.id, workspaceId))
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeWorkspace(row.value))
        : Option.none<Workspace>();
    }),

  removeById: (workspaceId: Workspace["id"]) =>
    client.useTx("rows.workspaces.remove", async (tx) => {
      const executionRows = await tx
        .select({ id: tables.executionsTable.id })
        .from(tables.executionsTable)
        .where(eq(tables.executionsTable.workspaceId, workspaceId));
      const executionIds = executionRows.map((execution) => execution.id);

      if (executionIds.length > 0) {
        await tx
          .delete(tables.executionInteractionsTable)
          .where(inArray(tables.executionInteractionsTable.executionId, executionIds));
      }

      await tx
        .delete(tables.executionsTable)
        .where(eq(tables.executionsTable.workspaceId, workspaceId));

      await tx
        .delete(tables.sourceCredentialBindingsTable)
        .where(eq(tables.sourceCredentialBindingsTable.workspaceId, workspaceId));

      await tx
        .delete(tables.sourcesTable)
        .where(eq(tables.sourcesTable.workspaceId, workspaceId));

      await tx
        .delete(tables.policiesTable)
        .where(eq(tables.policiesTable.workspaceId, workspaceId));

      await tx
        .delete(tables.localInstallationsTable)
        .where(eq(tables.localInstallationsTable.workspaceId, workspaceId));

      const deleted = await tx
        .delete(tables.workspacesTable)
        .where(eq(tables.workspacesTable.id, workspaceId))
        .returning();

      return deleted.length > 0;
    }),
});
