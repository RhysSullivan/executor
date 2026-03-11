import type {
  StoredCodeMigrationRecord,
} from "#schema";
import { StoredCodeMigrationRecordSchema } from "#schema";
import { Schema } from "effect";
import { asc } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";

const decodeStoredCodeMigrationRecord = Schema.decodeUnknownSync(
  StoredCodeMigrationRecordSchema,
);

export const createCodeMigrationsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listAll: () =>
    client.use("rows.code_migrations.list_all", async (db) => {
      const rows = await db
        .select()
        .from(tables.codeMigrationsTable)
        .orderBy(asc(tables.codeMigrationsTable.appliedAt));

      return rows.map((row) => decodeStoredCodeMigrationRecord(row));
    }),

  upsert: (record: StoredCodeMigrationRecord) =>
    client.use("rows.code_migrations.upsert", async (db) => {
      await db
        .insert(tables.codeMigrationsTable)
        .values(record)
        .onConflictDoNothing();
    }),

  clearAll: () =>
    client.use("rows.code_migrations.clear_all", async (db) => {
      await db.delete(tables.codeMigrationsTable);
    }),
});
