import { type Workspace, WorkspaceSchema } from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import {
  cleanupOrphanedSourceRecipes,
  firstOption,
  postgresSecretHandlesFromAuthArtifacts,
} from "./shared";

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
      const sourceRows = await tx
        .select({
          recipeId: tables.sourcesTable.recipeId,
          recipeRevisionId: tables.sourcesTable.recipeRevisionId,
        })
        .from(tables.sourcesTable)
        .where(eq(tables.sourcesTable.workspaceId, workspaceId));
      const executionIds = executionRows.map((execution) => execution.id);
      const recipeIds = sourceRows.map((source) => source.recipeId);
      const recipeRevisionIds = sourceRows.map((source) => source.recipeRevisionId);
      const authArtifacts = await tx
        .select({
          artifactKind: tables.authArtifactsTable.artifactKind,
          configJson: tables.authArtifactsTable.configJson,
        })
        .from(tables.authArtifactsTable)
        .where(eq(tables.authArtifactsTable.workspaceId, workspaceId));
      const postgresSecretHandles = postgresSecretHandlesFromAuthArtifacts(authArtifacts);

      if (executionIds.length > 0) {
        await tx
          .delete(tables.executionInteractionsTable)
          .where(inArray(tables.executionInteractionsTable.executionId, executionIds));

        await tx
          .delete(tables.executionStepsTable)
          .where(inArray(tables.executionStepsTable.executionId, executionIds));
      }

      await tx
        .delete(tables.executionsTable)
        .where(eq(tables.executionsTable.workspaceId, workspaceId));

      await tx
        .delete(tables.authLeasesTable)
        .where(eq(tables.authLeasesTable.workspaceId, workspaceId));

      await tx
        .delete(tables.sourceAuthSessionsTable)
        .where(eq(tables.sourceAuthSessionsTable.workspaceId, workspaceId));

      await tx
        .delete(tables.workspaceSourceOauthClientsTable)
        .where(eq(tables.workspaceSourceOauthClientsTable.workspaceId, workspaceId));

      await tx
        .delete(tables.authArtifactsTable)
        .where(eq(tables.authArtifactsTable.workspaceId, workspaceId));

      await tx
        .delete(tables.sourcesTable)
        .where(eq(tables.sourcesTable.workspaceId, workspaceId));

      await cleanupOrphanedSourceRecipes({
        tx,
        tables,
        candidateRecipeIds: recipeIds,
        candidateRecipeRevisionIds: recipeRevisionIds,
      });

      await tx
        .delete(tables.policiesTable)
        .where(
          and(
            eq(tables.policiesTable.scopeType, "workspace"),
            eq(tables.policiesTable.workspaceId, workspaceId),
          ),
        );

      await tx
        .delete(tables.localInstallationsTable)
        .where(eq(tables.localInstallationsTable.workspaceId, workspaceId));

      if (postgresSecretHandles.length > 0) {
        await tx
          .delete(tables.secretMaterialsTable)
          .where(inArray(tables.secretMaterialsTable.id, postgresSecretHandles));
      }

      const deleted = await tx
        .delete(tables.workspacesTable)
        .where(eq(tables.workspacesTable.id, workspaceId))
        .returning();

      return deleted.length > 0;
    }),
});
