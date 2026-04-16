// ---------------------------------------------------------------------------
// DBSchema → drizzle-orm sqlite tables
//
// The only dialect-specific piece of the sqlite backend. Produces a
// `Record<modelName, SqliteTable>` that the storage-drizzle adapter uses
// to build queries. Also produces the list of CREATE TABLE / CREATE INDEX
// statements needed to bootstrap an empty database (used by the
// constructor path).
// ---------------------------------------------------------------------------

import { relations } from "drizzle-orm";
import {
  sqliteTable,
  text,
  real,
  integer,
  type SQLiteColumnBuilderBase,
} from "drizzle-orm/sqlite-core";

import type { DBSchema, DBFieldAttribute } from "@executor/storage-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuilder = any;

const buildColumn = (
  physical: string,
  attr: DBFieldAttribute,
): SQLiteColumnBuilderBase => {
  let col: AnyBuilder;
  switch (attr.type) {
    case "string":
      col = text(physical);
      break;
    case "number":
      col = real(physical);
      break;
    case "boolean":
      col = integer(physical, { mode: "boolean" });
      break;
    case "date":
      col = integer(physical, { mode: "timestamp_ms" });
      break;
    case "json":
      col = text(physical, { mode: "json" });
      break;
    case "string[]":
    case "number[]":
      col = text(physical, { mode: "json" });
      break;
    default:
      col = text(physical, { mode: "json" });
      break;
  }
  // No .notNull() — see note in buildCreateTableStatements.
  if (attr.unique) col = col.unique();
  return col as SQLiteColumnBuilderBase;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqliteTableMap = Record<string, any>;

/**
 * Compiled drizzle schema for a logical `DBSchema`. Includes the table map
 * plus any `relations()` declarations derived from fields that carry
 * `references`. The storage-drizzle adapter passes the whole object into
 * `drizzle(client, { schema })` so `db.query[model]` is populated and the
 * `findFirst({ with: { … } })` join-resolution path works.
 */
export interface CompiledSqliteSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tables: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly relations: Record<string, any>;
}

export const dbSchemaToSqliteTables = (schema: DBSchema): SqliteTableMap =>
  dbSchemaToSqliteCompiled(schema).tables;

export const dbSchemaToSqliteCompiled = (
  schema: DBSchema,
): CompiledSqliteSchema => {
  const tables: SqliteTableMap = {};
  for (const [modelKey, def] of Object.entries(schema)) {
    const cols: Record<string, SQLiteColumnBuilderBase> = {
      id: text("id").primaryKey().notNull(),
    };
    for (const [fieldName, attr] of Object.entries(def.fields)) {
      if (fieldName === "id") continue;
      const physical = attr.fieldName ?? fieldName;
      if (physical === "id") continue;
      cols[physical] = buildColumn(physical, attr);
    }
    tables[modelKey] = sqliteTable(def.modelName ?? modelKey, cols);
  }

  // Derive relations from `references` on each field. A field with
  // `references: { model: "foo", field: "id" }` becomes a many-side
  // reverse lookup (`many(foo)` on the owning table) plus a one-side
  // back-reference (`one(this)` on the referenced table). That matches
  // how upstream better-auth expects db._.fullSchema to look when it
  // routes a join through db.query[model].findFirst({ with: … }).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rels: Record<string, any> = {};
  for (const [modelKey, def] of Object.entries(schema)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perTable: Record<string, any> = {};
    let hasAny = false;
    for (const [fieldName, attr] of Object.entries(def.fields)) {
      const ref = attr.references;
      if (!ref) continue;
      const refTable = tables[ref.model];
      if (!refTable) continue;
      perTable[ref.model] = { kind: "one", fieldName, ref };
      hasAny = true;
      // Also create a many on the parent side keyed by the owning model.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parent: Record<string, any> = rels[ref.model] ?? {};
      parent[modelKey] = { kind: "many" };
      rels[ref.model] = parent;
    }
    if (hasAny) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing: Record<string, any> = rels[modelKey] ?? {};
      for (const [k, v] of Object.entries(perTable)) existing[k] = v;
      rels[modelKey] = existing;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outRelations: Record<string, any> = {};
  for (const [modelKey, entries] of Object.entries(rels)) {
    const table = tables[modelKey];
    if (!table) continue;
    outRelations[`${modelKey}Relations`] = relations(
      table,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ one, many }: { one: any; many: any }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const shape: Record<string, any> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const [targetModel, e] of Object.entries(entries as Record<string, any>)) {
          const targetTable = tables[targetModel];
          if (!targetTable) continue;
          if (e.kind === "one") {
            const physical = schema[modelKey]!.fields[e.fieldName]?.fieldName ?? e.fieldName;
            shape[targetModel] = one(targetTable, {
              fields: [table[physical]],
              references: [targetTable[e.ref.field]],
            });
          } else {
            shape[targetModel] = many(targetTable);
          }
        }
        return shape;
      },
    );
  }

  return { tables, relations: outRelations };
};

// ---------------------------------------------------------------------------
// DDL — CREATE TABLE IF NOT EXISTS
//
// drizzle-orm can emit migrations via drizzle-kit, but we want zero-config
// setup against an empty db. Build simple CREATE TABLE statements from
// the schema. Run once at adapter construction time.
// ---------------------------------------------------------------------------

const sqliteTypeFor = (attr: DBFieldAttribute): string => {
  switch (attr.type) {
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    case "date":
      return "INTEGER"; // timestamp_ms
    default:
      return "TEXT";
  }
};

export const buildCreateTableStatements = (schema: DBSchema): string[] => {
  const stmts: string[] = [];
  for (const [modelKey, def] of Object.entries(schema)) {
    if (def.disableMigration) continue;
    const tableName = def.modelName ?? modelKey;
    const cols: string[] = [`"id" TEXT PRIMARY KEY NOT NULL`];
    for (const [fieldName, attr] of Object.entries(def.fields)) {
      if (fieldName === "id") continue;
      const physical = attr.fieldName ?? fieldName;
      if (physical === "id") continue;
      // NOTE: we deliberately do NOT emit NOT NULL even when
      // `required !== false`. In our schema convention `required` means
      // "must be supplied on create", not "DB-level NOT NULL". This
      // matches the pre-drizzle storage-file adapter's behavior.
      const parts: string[] = [`"${physical}" ${sqliteTypeFor(attr)}`];
      if (attr.unique) parts.push("UNIQUE");
      cols.push(parts.join(" "));
    }
    stmts.push(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (${cols.join(", ")})`,
    );
    for (const [fieldName, attr] of Object.entries(def.fields)) {
      if (!attr.index) continue;
      const physical = attr.fieldName ?? fieldName;
      stmts.push(
        `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${physical}" ON "${tableName}" ("${physical}")`,
      );
    }
  }
  return stmts;
};
