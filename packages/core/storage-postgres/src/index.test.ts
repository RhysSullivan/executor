// ---------------------------------------------------------------------------
// Postgres adapter conformance test
// ---------------------------------------------------------------------------
//
// Runs against PGlite spun up by `scripts/test-globalsetup.ts` (same
// pattern apps/cloud uses). Port 5435 so it doesn't clash with the
// cloud test DB on 5434.

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { relations } from "drizzle-orm";
import {
  pgTable,
  primaryKey,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

import type { DBAdapter, StorageFailure } from "@executor-js/storage-core";
import { conformanceSchema, runAdapterConformance } from "@executor-js/storage-core/testing";

import { makePostgresAdapter } from "./index";

const url = "postgresql://postgres:postgres@127.0.0.1:5435/postgres";

class PostgresTestDatabaseError extends Data.TaggedError("PostgresTestDatabaseError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

// max=1 so BEGIN/COMMIT sent via `db.execute(sql.raw(...))` always hit
// the same connection — postgres.js with a larger pool rejects unsafe
// transaction control that isn't bound to a single reserved client.
const sql = postgres(url, {
  max: 1,
  idle_timeout: 0,
  max_lifetime: 60,
  connect_timeout: 10,
  onnotice: () => undefined,
});

// Drizzle table definitions matching conformanceSchema
const source = pgTable("source", {
  id: text("id").primaryKey(),
  name: text("name"),
  priority: doublePrecision("priority"),
  enabled: boolean("enabled"),
  createdAt: timestamp("createdAt"),
  metadata: jsonb("metadata"),
});

const tag = pgTable("tag", {
  id: text("id").primaryKey(),
  label: text("label"),
});

const source_tag = pgTable("source_tag", {
  id: text("id").primaryKey(),
  sourceId: text("sourceId").references(() => source.id, { onDelete: "cascade" }),
  note: text("note"),
});

const with_defaults = pgTable("with_defaults", {
  id: text("id").primaryKey(),
  name: text("name"),
  nickname: text("nickname"),
  touchedAt: timestamp("touchedAt"),
});

const scoped_item = pgTable(
  "scoped_item",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    label: text("label"),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] })],
);

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

const createConformanceTables = Effect.tryPromise({
  try: async () => {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "source" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT,
        "priority" DOUBLE PRECISION,
        "enabled" BOOLEAN,
        "createdAt" TIMESTAMPTZ,
        "metadata" JSONB
      )`,
    );
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "tag" (
        "id" TEXT PRIMARY KEY,
        "label" TEXT
      )`,
    );
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "source_tag" (
        "id" TEXT PRIMARY KEY,
        "sourceId" TEXT REFERENCES "source"("id") ON DELETE CASCADE,
        "note" TEXT
      )`,
    );
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "with_defaults" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT,
        "nickname" TEXT,
        "touchedAt" TIMESTAMPTZ
      )`,
    );
  },
  catch: (cause) =>
    new PostgresTestDatabaseError({
      message: "failed to create postgres conformance tables",
      cause,
    }),
});

const resetTables = Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: () =>
      sql`DROP TABLE IF EXISTS "source", "tag", "source_tag", "with_defaults", "blob" CASCADE`.then(
        () => undefined,
      ),
    catch: (cause) =>
      new PostgresTestDatabaseError({
        message: "failed to reset postgres conformance tables",
        cause,
      }),
  });
  yield* createConformanceTables;
});

const withAdapter = <A, E>(
  fn: (adapter: DBAdapter) => Effect.Effect<A, E>,
): Effect.Effect<A, E | StorageFailure | PostgresTestDatabaseError> =>
  Effect.gen(function* () {
    yield* resetTables;
    const db = drizzle(sql, { schema: conformanceTables });
    const adapter = makePostgresAdapter({
      db,
      schema: conformanceSchema,
    });
    return yield* fn(adapter);
  });

runAdapterConformance("postgres", withAdapter);

const scopedSchema = {
  scoped_item: {
    fields: {
      scope_id: { type: "string", required: true, index: true },
      label: { type: "string", required: true },
    },
  },
} as const;

const resetScopedTable = Effect.tryPromise({
  try: async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS "scoped_item" CASCADE`);
    await sql.unsafe(
      `CREATE TABLE "scoped_item" (
        "id" TEXT NOT NULL,
        "scope_id" TEXT NOT NULL,
        "label" TEXT,
        PRIMARY KEY ("scope_id", "id")
      )`,
    );
  },
  catch: (cause) =>
    new PostgresTestDatabaseError({
      message: "failed to reset scoped_item table",
      cause,
    }),
});

const makeScopedAdapter = () =>
  makePostgresAdapter({
    db: drizzle(sql, { schema: { scoped_item } }),
    schema: scopedSchema,
  });

describe("postgres scoped row identity", () => {
  it.effect("update pins composite identity when id is reused across scopes", () =>
    Effect.gen(function* () {
      yield* resetScopedTable;
      const adapter = makeScopedAdapter();

      yield* adapter.create({
        model: "scoped_item",
        forceAllowId: true,
        data: { id: "shared", scope_id: "scope-a", label: "a" },
      });
      yield* adapter.create({
        model: "scoped_item",
        forceAllowId: true,
        data: { id: "shared", scope_id: "scope-b", label: "b" },
      });

      yield* adapter.update({
        model: "scoped_item",
        where: [
          { field: "id", value: "shared" },
          { field: "scope_id", value: "scope-a" },
        ],
        update: { label: "a-updated" },
      });

      const scopeA = yield* adapter.findOne<{ label: string }>({
        model: "scoped_item",
        where: [
          { field: "id", value: "shared" },
          { field: "scope_id", value: "scope-a" },
        ],
      });
      const scopeB = yield* adapter.findOne<{ label: string }>({
        model: "scoped_item",
        where: [
          { field: "id", value: "shared" },
          { field: "scope_id", value: "scope-b" },
        ],
      });
      expect(scopeA?.label).toBe("a-updated");
      expect(scopeB?.label).toBe("b");
    }),
  );

  it.effect("delete pins composite identity when id is reused across scopes", () =>
    Effect.gen(function* () {
      yield* resetScopedTable;
      const adapter = makeScopedAdapter();

      yield* adapter.create({
        model: "scoped_item",
        forceAllowId: true,
        data: { id: "shared", scope_id: "scope-a", label: "a" },
      });
      yield* adapter.create({
        model: "scoped_item",
        forceAllowId: true,
        data: { id: "shared", scope_id: "scope-b", label: "b" },
      });

      yield* adapter.delete({
        model: "scoped_item",
        where: [
          { field: "id", value: "shared" },
          { field: "scope_id", value: "scope-a" },
        ],
      });

      const scopeA = yield* adapter.findOne<{ label: string }>({
        model: "scoped_item",
        where: [
          { field: "id", value: "shared" },
          { field: "scope_id", value: "scope-a" },
        ],
      });
      const scopeB = yield* adapter.findOne<{ label: string }>({
        model: "scoped_item",
        where: [
          { field: "id", value: "shared" },
          { field: "scope_id", value: "scope-b" },
        ],
      });
      expect(scopeA).toBeNull();
      expect(scopeB?.label).toBe("b");
    }),
  );
});
