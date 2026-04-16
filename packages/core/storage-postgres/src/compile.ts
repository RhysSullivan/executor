// ---------------------------------------------------------------------------
// DBSchema → drizzle-orm pg tables.
//
// Postgres variant of storage-file/compile.ts. Produces drizzle pg tables
// keyed by logical model name so the storage-drizzle adapter can operate
// against postgres via drizzle's cross-dialect query builder.
// ---------------------------------------------------------------------------

import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  type PgColumnBuilderBase,
} from "drizzle-orm/pg-core";

import type { DBSchema, DBFieldAttribute } from "@executor/storage-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuilder = any;

const buildColumn = (
  physical: string,
  attr: DBFieldAttribute,
): PgColumnBuilderBase => {
  let col: AnyBuilder;
  switch (attr.type) {
    case "string":
      col = text(physical);
      break;
    case "number":
      col = doublePrecision(physical);
      break;
    case "boolean":
      col = boolean(physical);
      break;
    case "date":
      col = timestamp(physical, { mode: "date", withTimezone: true });
      break;
    case "json":
      col = jsonb(physical);
      break;
    case "string[]":
    case "number[]":
      col = jsonb(physical);
      break;
    default:
      col = jsonb(physical);
      break;
  }
  if (attr.unique) col = col.unique();
  return col as PgColumnBuilderBase;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PgTableMap = Record<string, any>;

export interface CompiledPgSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tables: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly relations: Record<string, any>;
}

export const dbSchemaToPgTables = (schema: DBSchema): PgTableMap =>
  dbSchemaToPgCompiled(schema).tables;

export const dbSchemaToPgCompiled = (schema: DBSchema): CompiledPgSchema => {
  const tables: PgTableMap = {};
  for (const [modelKey, def] of Object.entries(schema)) {
    const cols: Record<string, PgColumnBuilderBase> = {
      id: text("id").primaryKey().notNull(),
    };
    for (const [fieldName, attr] of Object.entries(def.fields)) {
      if (fieldName === "id") continue;
      const physical = attr.fieldName ?? fieldName;
      if (physical === "id") continue;
      cols[physical] = buildColumn(physical, attr);
    }
    tables[modelKey] = pgTable(def.modelName ?? modelKey, cols);
  }

  // See storage-file/compile.ts for the shape; this mirrors it for pg.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rels: Record<string, Record<string, any>> = {};
  for (const [modelKey, def] of Object.entries(schema)) {
    for (const [fieldName, attr] of Object.entries(def.fields)) {
      const ref = attr.references;
      if (!ref) continue;
      if (!tables[ref.model]) continue;
      rels[modelKey] = rels[modelKey] ?? {};
      rels[modelKey]![ref.model] = { kind: "one", fieldName, ref };
      rels[ref.model] = rels[ref.model] ?? {};
      rels[ref.model]![modelKey] = { kind: "many" };
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
        for (const [targetModel, e] of Object.entries(entries)) {
          const targetTable = tables[targetModel];
          if (!targetTable) continue;
          if ((e as { kind: string }).kind === "one") {
            const entry = e as {
              kind: "one";
              fieldName: string;
              ref: { field: string };
            };
            const physical =
              schema[modelKey]!.fields[entry.fieldName]?.fieldName ??
              entry.fieldName;
            shape[targetModel] = one(targetTable, {
              fields: [table[physical]],
              references: [targetTable[entry.ref.field]],
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

