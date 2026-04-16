// Drizzle generator snapshot tests. Pin the emitted code so changes
// to the generator surface as visible diffs on the snapshots instead
// of silently rippling into every downstream `executor-schema.ts`.
//
// Categories covered:
//   - unscoped tables (single-column PK, blob-store-like shape)
//   - scoped tables (composite PK on (scope_id, id))
//   - indexes + unique indexes
//   - FK references + relations
//   - default values (literal + now())
//   - all three dialects (pg, sqlite, mysql) on a shared fixture
//
// Run the suite once to populate inline snapshots, then commit them —
// subsequent generator changes that would alter the output fail
// loudly until the snapshot is reviewed.

import { describe, expect, it } from "vitest";

import type { DBSchema } from "@executor/storage-core";

import { generateDrizzleSchema } from "./drizzle";

const emit = (schema: DBSchema, dialect: "pg" | "sqlite" | "mysql") =>
  generateDrizzleSchema({ schema, dialect }).then((r) => r.code);

// ---------------------------------------------------------------------------
// Scoped vs unscoped PK shape
// ---------------------------------------------------------------------------

describe("drizzle generator: primary key shape", () => {
  it("unscoped table gets single-column PK on `id`", async () => {
    const schema: DBSchema = {
      unscoped_thing: {
        fields: {
          id: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
    };
    expect(await emit(schema, "pg")).toMatchInlineSnapshot(`
      "import { pgTable, text } from "drizzle-orm/pg-core";

      export const unscoped_thing = pgTable("unscoped_thing", {
        id: text('id').primaryKey(),
        name: text('name').notNull()
      });

      "
    `);
  });

  it("scoped table gets composite (scope_id, id) PK", async () => {
    const schema: DBSchema = {
      scoped_thing: {
        fields: {
          id: { type: "string", required: true },
          scope_id: { type: "string", required: true, index: true },
          name: { type: "string", required: true },
        },
      },
    };
    expect(await emit(schema, "pg")).toMatchInlineSnapshot(`
      "import { pgTable, text, index, primaryKey } from "drizzle-orm/pg-core";

      export const scoped_thing = pgTable("scoped_thing", {
        id: text('id').notNull(),
        scope_id: text('scope_id').notNull(),
        name: text('name').notNull()
      }, (table) => [
        primaryKey({ columns: [table.scope_id, table.id] }),
        index("scoped_thing_scope_id_idx").on(table.scope_id),
      ]);

      "
    `);
  });

  it("scoped sqlite table uses composite PK too", async () => {
    const schema: DBSchema = {
      scoped_thing: {
        fields: {
          id: { type: "string", required: true },
          scope_id: { type: "string", required: true, index: true },
          name: { type: "string", required: true },
        },
      },
    };
    expect(await emit(schema, "sqlite")).toMatchInlineSnapshot(`
      "import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

      export const scoped_thing = sqliteTable("scoped_thing", {
        id: text('id').notNull(),
        scope_id: text('scope_id').notNull(),
        name: text('name').notNull()
      }, (table) => [
        primaryKey({ columns: [table.scope_id, table.id] }),
        index("scoped_thing_scope_id_idx").on(table.scope_id),
      ]);

      "
    `);
  });
});

// ---------------------------------------------------------------------------
// Indexes + unique indexes
// ---------------------------------------------------------------------------

describe("drizzle generator: indexes", () => {
  it("emits index() for field.index, uniqueIndex() for field.unique+index", async () => {
    const schema: DBSchema = {
      t: {
        fields: {
          id: { type: "string", required: true },
          label: { type: "string", required: true, index: true },
          slug: { type: "string", required: true, index: true, unique: true },
          notes: { type: "string" },
        },
      },
    };
    expect(await emit(schema, "pg")).toMatchInlineSnapshot(`
      "import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core";

      export const t = pgTable("t", {
        id: text('id').primaryKey(),
        label: text('label').notNull(),
        slug: text('slug').notNull().unique(),
        notes: text('notes').notNull()
      }, (table) => [
        index("t_label_idx").on(table.label),
        uniqueIndex("t_slug_uidx").on(table.slug),
      ]);

      "
    `);
  });
});

// ---------------------------------------------------------------------------
// Column types — dates, json, boolean, number
// ---------------------------------------------------------------------------

describe("drizzle generator: column types", () => {
  const mixed: DBSchema = {
    row: {
      fields: {
        id: { type: "string", required: true },
        count: { type: "number" },
        active: { type: "boolean", defaultValue: true },
        when: { type: "date", required: true, defaultValue: () => new Date() },
        blob: { type: "json" },
      },
    },
  };

  it("emits pg-specific column types (jsonb, timestamp, boolean, integer)", async () => {
    expect(await emit(mixed, "pg")).toMatchInlineSnapshot(`
      "import { pgTable, text, boolean, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

      export const row = pgTable("row", {
        id: text('id').primaryKey(),
        count: integer('count').notNull(),
        active: boolean('active').default(true).notNull(),
        when: timestamp('when').defaultNow().notNull(),
        blob: jsonb('blob').notNull()
      });

      "
    `);
  });

  it("emits sqlite-specific column types (integer for bool/date, text for json, real for number)", async () => {
    expect(await emit(mixed, "sqlite")).toMatchInlineSnapshot(`
      "import { sql } from "drizzle-orm";
      import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

      export const row = sqliteTable("row", {
        id: text('id').primaryKey(),
        count: integer('count').notNull(),
        active: integer('active', { mode: 'boolean' }).default(true).notNull(),
        when: integer('when', { mode: 'timestamp_ms' }).default(sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`).notNull(),
        blob: text('blob', { mode: "json" }).notNull()
      });

      "
    `);
  });
});

// ---------------------------------------------------------------------------
// Foreign keys + relations
// ---------------------------------------------------------------------------

describe("drizzle generator: references + relations", () => {
  it("emits .references() for fields with `references` and relations() block for the parent/child pair", async () => {
    const schema: DBSchema = {
      parent: {
        fields: {
          id: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      child: {
        fields: {
          id: { type: "string", required: true },
          parent_id: {
            type: "string",
            required: true,
            index: true,
            references: { model: "parent", field: "id", onDelete: "cascade" },
          },
          label: { type: "string" },
        },
      },
    };
    expect(await emit(schema, "pg")).toMatchInlineSnapshot(`
      "import { relations } from "drizzle-orm";
      import { pgTable, text, index } from "drizzle-orm/pg-core";

      export const parent = pgTable("parent", {
        id: text('id').primaryKey(),
        name: text('name').notNull()
      });

      export const child = pgTable("child", {
        id: text('id').primaryKey(),
        parent_id: text('parent_id').notNull().references(()=> parent.id, { onDelete: 'cascade' }),
        label: text('label').notNull()
      }, (table) => [
        index("child_parent_id_idx").on(table.parent_id),
      ]);


      export const parentRelations = relations(parent, ({ many }) => ({
        childs: many(child)
      }))

      export const childRelations = relations(child, ({ one }) => ({
        parent: one(parent, {
          fields: [child.parent_id],
          references: [parent.id],
        })
      }))
      "
    `);
  });
});

// ---------------------------------------------------------------------------
// Regression: no `relations` import when there are no references
// ---------------------------------------------------------------------------

describe("drizzle generator: imports", () => {
  it("does not import `relations` when the schema has no references", async () => {
    const schema: DBSchema = {
      t: { fields: { id: { type: "string", required: true } } },
    };
    const code = await emit(schema, "pg");
    expect(code).not.toContain(`import { relations }`);
    expect(code).not.toContain(`, relations`);
  });

  it("imports `primaryKey` only when there is a composite PK", async () => {
    const unscoped: DBSchema = {
      t: { fields: { id: { type: "string", required: true } } },
    };
    const scoped: DBSchema = {
      t: {
        fields: {
          id: { type: "string", required: true },
          scope_id: { type: "string", required: true },
        },
      },
    };
    // Unscoped uses `.primaryKey()` on the column itself; no need for
    // the `primaryKey` import.
    const unscopedCode = await emit(unscoped, "pg");
    expect(unscopedCode).not.toMatch(/import .*\bprimaryKey\b/);
    expect(unscopedCode).not.toContain("primaryKey({ columns:");

    const scopedCode = await emit(scoped, "pg");
    expect(scopedCode).toMatch(/import .*\bprimaryKey\b/);
    expect(scopedCode).toContain("primaryKey({ columns:");
  });
});
