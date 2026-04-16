import { Effect } from "effect";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  real,
  integer,
  getTableConfig,
} from "drizzle-orm/sqlite-core";

import type { DBAdapter } from "@executor/storage-core";
import {
  conformanceSchema,
  runAdapterConformance,
} from "@executor/storage-core/testing";

import { makeSqliteAdapter } from "./index";

// ---------------------------------------------------------------------------
// Drizzle table definitions matching `conformanceSchema`. These are the
// test-only equivalent of the CLI-generated `executor-schema.ts` — needed
// because the conformance schema is a test fixture, not a real plugin.
// ---------------------------------------------------------------------------

const source = sqliteTable("source", {
  id: text("id").primaryKey().notNull(),
  name: text("name"),
  priority: real("priority"),
  enabled: integer("enabled", { mode: "boolean" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  metadata: text("metadata", { mode: "json" }),
});

const tag = sqliteTable("tag", {
  id: text("id").primaryKey().notNull(),
  label: text("label"),
});

const source_tag = sqliteTable("source_tag", {
  id: text("id").primaryKey().notNull(),
  sourceId: text("sourceId"),
  note: text("note"),
});

const with_defaults = sqliteTable("with_defaults", {
  id: text("id").primaryKey().notNull(),
  name: text("name"),
  nickname: text("nickname"),
  touchedAt: integer("touchedAt", { mode: "timestamp_ms" }),
});

const sourceRelations = relations(source, ({ many }) => ({
  source_tag: many(source_tag),
}));

const sourceTagRelations = relations(source_tag, ({ one }) => ({
  source: one(source, {
    fields: [source_tag.sourceId],
    references: [source.id],
  }),
}));

const conformanceTables = {
  source,
  tag,
  source_tag,
  with_defaults,
  sourceRelations,
  sourceTagRelations,
};

/**
 * Bootstrap tables in an in-memory database from drizzle table definitions.
 */
const bootstrapTables = (
  db: ReturnType<typeof drizzle>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tables: Record<string, any>,
): void => {
  for (const table of Object.values(tables)) {
    // Skip relations — they aren't tables
    try {
      const config = getTableConfig(table);
      const cols = config.columns.map((col) => {
        const parts = [`"${col.name}" ${col.getSQLType()}`];
        if (col.primary) parts.push("PRIMARY KEY");
        if (col.notNull) parts.push("NOT NULL");
        if (col.isUnique) parts.push("UNIQUE");
        return parts.join(" ");
      });
      db.run(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${config.name}" (${cols.join(", ")})`,
        ),
      );
    } catch {
      // Not a table (e.g. relations) — skip
    }
  }
};

const withAdapter = <A, E>(
  fn: (adapter: DBAdapter) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const sqlite = new Database(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema: conformanceTables as any });

    bootstrapTables(db, conformanceTables);

    const adapter = makeSqliteAdapter({
      db,
      schema: conformanceSchema,
    });
    return yield* fn(adapter);
  }) as Effect.Effect<A, E | Error>;

runAdapterConformance("sqlite (better-sqlite3 via drizzle)", withAdapter);
