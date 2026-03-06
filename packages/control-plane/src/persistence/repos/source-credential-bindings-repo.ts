import {
  type SourceCredentialBinding,
  SourceCredentialBindingSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, asc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption, withoutCreatedAt } from "./shared";

const decodeSourceCredentialBinding = Schema.decodeUnknownSync(
  SourceCredentialBindingSchema,
);

export const createSourceCredentialBindingsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByWorkspaceId: (workspaceId: SourceCredentialBinding["workspaceId"]) =>
    client.use("rows.source_credential_bindings.list_by_workspace", async (db) => {
      const rows = await db
        .select()
        .from(tables.sourceCredentialBindingsTable)
        .where(eq(tables.sourceCredentialBindingsTable.workspaceId, workspaceId))
        .orderBy(
          asc(tables.sourceCredentialBindingsTable.updatedAt),
          asc(tables.sourceCredentialBindingsTable.sourceId),
        );

      return rows.map((row) => decodeSourceCredentialBinding(row));
    }),

  getByWorkspaceAndSourceId: (
    workspaceId: SourceCredentialBinding["workspaceId"],
    sourceId: SourceCredentialBinding["sourceId"],
  ) =>
    client.use(
      "rows.source_credential_bindings.get_by_workspace_and_source_id",
      async (db) => {
        const rows = await db
          .select()
          .from(tables.sourceCredentialBindingsTable)
          .where(
            and(
              eq(tables.sourceCredentialBindingsTable.workspaceId, workspaceId),
              eq(tables.sourceCredentialBindingsTable.sourceId, sourceId),
            ),
          )
          .limit(1);

        const row = firstOption(rows);
        return Option.isSome(row)
          ? Option.some(decodeSourceCredentialBinding(row.value))
          : Option.none<SourceCredentialBinding>();
      },
    ),

  upsert: (binding: SourceCredentialBinding) =>
    client.use("rows.source_credential_bindings.upsert", async (db) => {
      await db
        .insert(tables.sourceCredentialBindingsTable)
        .values(binding)
        .onConflictDoUpdate({
          target: [
            tables.sourceCredentialBindingsTable.workspaceId,
            tables.sourceCredentialBindingsTable.sourceId,
          ],
          set: {
            ...withoutCreatedAt(binding),
          },
        });
    }),

  removeByWorkspaceAndSourceId: (
    workspaceId: SourceCredentialBinding["workspaceId"],
    sourceId: SourceCredentialBinding["sourceId"],
  ) =>
    client.use("rows.source_credential_bindings.remove", async (db) => {
      const deleted = await db
        .delete(tables.sourceCredentialBindingsTable)
        .where(
          and(
            eq(tables.sourceCredentialBindingsTable.workspaceId, workspaceId),
            eq(tables.sourceCredentialBindingsTable.sourceId, sourceId),
          ),
        )
        .returning();

      return deleted.length > 0;
    }),
});
