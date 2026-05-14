import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  foreignKey,
  integer,
  json,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createId } from "fumadb/cuid";
import { IdColumn, schema as fumaSchema, type AnyColumn, type AnyTable } from "fumadb/schema";

import type { FumaTables } from "./fuma-runtime";

export type PostgresDrizzleSchema = Record<string, unknown>;

export interface PostgresDrizzleSchemaOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace?: string;
  readonly version?: string;
}

export interface ExecutableDrizzleDb {
  readonly execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
  readonly transaction?: <A>(run: (tx: ExecutableDrizzleDb) => Promise<A>) => Promise<A>;
}

const defaultNamespace = "executor";
const defaultVersion = "1.0.0";

const parseVarcharLength = (type: string): number | undefined => {
  const match = /^varchar\((\d+)\)$/.exec(type);
  return match ? Number(match[1]) : undefined;
};

const mapForeignKeyAction = (action: string): "cascade" | "restrict" | "set null" => {
  if (action === "CASCADE") return "cascade";
  if (action === "SET NULL") return "set null";
  return "restrict";
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const binary = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  toDriver: (value) => value,
});

const pgColumnBuilder = (column: AnyColumn) => {
  let builder: any =
    column.type === "uuid"
      ? uuid(column.names.sql)
      : column.type === "string"
        ? text(column.names.sql)
        : column.type === "binary"
          ? binary(column.names.sql)
          : column.type === "bool"
            ? boolean(column.names.sql)
            : column.type === "bigint"
              ? bigint(column.names.sql, { mode: "bigint" })
              : column.type === "integer"
                ? integer(column.names.sql)
                : column.type === "decimal"
                  ? numeric(column.names.sql, { mode: "number" })
                  : column.type === "json"
                    ? json(column.names.sql)
                    : column.type === "date"
                      ? date(column.names.sql)
                      : column.type === "timestamp"
                        ? timestamp(column.names.sql)
                        : undefined;

  if (!builder) {
    const length = parseVarcharLength(column.type);
    if (length === undefined) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: schema generation fails fast for invalid FumaDB column types
      throw new Error(`Unsupported FumaDB column type for Postgres Drizzle: ${column.type}`);
    }
    builder = varchar(column.names.sql, { length });
  }

  if (column instanceof IdColumn) builder = builder.primaryKey();
  if (column.isUnique) builder = builder.unique(column.getUniqueConstraintName());
  if (!column.isNullable) builder = builder.notNull();

  if (column.default) {
    if ("value" in column.default) {
      builder = builder.default(column.default.value);
    } else if (column.default.runtime === "auto") {
      builder = builder.$defaultFn(() => createId());
    } else if (column.default.runtime === "now") {
      builder = builder.defaultNow();
    } else {
      builder = builder.$defaultFn(column.default.runtime);
    }
  }

  return builder;
};

const settingsTableName = (namespace: string) => `private_${namespace}_settings`;

export const createPostgresDrizzleSchema = <const TTables extends FumaTables>(
  options: PostgresDrizzleSchemaOptions<TTables>,
): PostgresDrizzleSchema => {
  const namespace = options.namespace ?? defaultNamespace;
  const version = options.version ?? defaultVersion;
  const tables = fumaSchema({
    version,
    tables: options.tables,
  }).tables as Record<string, AnyTable>;
  const schema: PostgresDrizzleSchema = {};
  const tableMap: Record<string, any> = {};

  for (const table of Object.values(tables)) {
    const columns: Record<string, any> = {};
    for (const [columnKey, column] of Object.entries(table.columns)) {
      columns[columnKey] = pgColumnBuilder(column);
    }

    const drizzleTable = pgTable(table.names.sql, columns, (self: any) => [
      ...table
        .getUniqueConstraints("table")
        .map((constraint) =>
          (uniqueIndex(constraint.name) as any).on(
            ...constraint.columns.map((column) => self[column.names.drizzle]),
          ),
        ),
      ...table.foreignKeys.map((key) =>
        (foreignKey as any)({
          columns: key.columns.map((column) => self[column.names.drizzle]),
          foreignColumns: key.referencedColumns.map(
            (column) => tableMap[key.referencedTable.names.drizzle][column.names.drizzle],
          ),
          name: key.name,
        })
          .onUpdate(mapForeignKeyAction(key.onUpdate))
          .onDelete(mapForeignKeyAction(key.onDelete)),
      ),
    ]);

    schema[table.names.drizzle] = drizzleTable;
    tableMap[table.names.drizzle] = drizzleTable;
  }

  for (const table of Object.values(tables)) {
    const relationEntries = Object.values(table.relations);
    if (relationEntries.length === 0) continue;

    schema[`${table.names.drizzle}Relations`] = (relations as any)(
      tableMap[table.names.drizzle],
      ({ one, many }: any) => {
        const out: Record<string, unknown> = {};
        for (const relation of relationEntries) {
          const targetTable = tableMap[relation.table.names.drizzle];
          const relationOptions: any = {
            relationName: relation.id,
          };

          if (!relation.implied || relation.type === "one") {
            relationOptions.fields = relation.on.map(
              ([left]) => tableMap[table.names.drizzle][table.columns[left].names.drizzle],
            );
            relationOptions.references = relation.on.map(
              ([, right]) => targetTable[relation.table.columns[right].names.drizzle],
            );
          }

          out[relation.name] =
            relation.type === "one"
              ? one(targetTable, relationOptions)
              : many(targetTable, relationOptions);
        }
        return out;
      },
    );
  }

  const settings = settingsTableName(namespace);
  schema[settings] = pgTable(settings, {
    id: varchar("id", { length: 255 }).primaryKey().notNull(),
    version: varchar("version", { length: 255 }).notNull().default(version),
  });

  return schema;
};

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const pgType = (column: AnyColumn): string => {
  if (column.type === "uuid") return "uuid";
  if (column.type === "string") return "text";
  if (column.type === "binary") return "bytea";
  if (column.type === "bool") return "boolean";
  if (column.type === "json") return "json";
  if (column.type.startsWith("varchar(")) return column.type;
  return column.type;
};

const defaultSql = (column: AnyColumn): string | undefined => {
  if (!column.default) return undefined;

  if ("runtime" in column.default) {
    return column.default.runtime === "now" ? "CURRENT_TIMESTAMP" : undefined;
  }

  const value = column.default.value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (column.type === "json") return `${quoteLiteral(JSON.stringify(value))}::json`;
  if (value instanceof Uint8Array) {
    return `decode(${quoteLiteral(bytesToHex(value))}, 'hex')`;
  }
  return quoteLiteral(String(value));
};

const columnDefinitionSql = (column: AnyColumn): string => {
  const parts = [quoteIdent(column.names.sql), pgType(column)];
  if (column instanceof IdColumn) parts.push("PRIMARY KEY");
  if (!column.isNullable) parts.push("NOT NULL");
  const defaultValue = defaultSql(column);
  if (defaultValue) parts.push("DEFAULT", defaultValue);
  return parts.join(" ");
};

const createTableSql = (table: AnyTable): string => {
  const constraints = table.foreignKeys.map((key) => {
    const columns = key.columns.map((column) => quoteIdent(column.names.sql)).join(", ");
    const referencedColumns = key.referencedColumns
      .map((column) => quoteIdent(column.names.sql))
      .join(", ");
    return [
      "CONSTRAINT",
      quoteIdent(key.name),
      "FOREIGN KEY",
      `(${columns})`,
      "REFERENCES",
      quoteIdent(key.referencedTable.names.sql),
      `(${referencedColumns})`,
      "ON UPDATE",
      key.onUpdate,
      "ON DELETE",
      key.onDelete,
    ].join(" ");
  });

  return [
    "CREATE TABLE IF NOT EXISTS",
    quoteIdent(table.names.sql),
    `(${[...Object.values(table.columns).map(columnDefinitionSql), ...constraints].join(", ")})`,
  ].join(" ");
};

const createUniqueIndexSql = (
  table: AnyTable,
  constraint: { name: string; columns: AnyColumn[] },
) =>
  [
    "CREATE UNIQUE INDEX IF NOT EXISTS",
    quoteIdent(constraint.name),
    "ON",
    quoteIdent(table.names.sql),
    `(${constraint.columns.map((column) => quoteIdent(column.names.sql)).join(", ")})`,
  ].join(" ");

const createSettingsTableSql = (namespace: string, version: string) =>
  [
    "CREATE TABLE IF NOT EXISTS",
    quoteIdent(settingsTableName(namespace)),
    `(${quoteIdent("id")} varchar(255) PRIMARY KEY NOT NULL, ${quoteIdent("version")} varchar(255) NOT NULL DEFAULT ${quoteLiteral(version)})`,
  ].join(" ");

export const ensurePostgresFumaSchema = async <const TTables extends FumaTables>(
  db: ExecutableDrizzleDb,
  options: PostgresDrizzleSchemaOptions<TTables>,
): Promise<void> => {
  const namespace = options.namespace ?? defaultNamespace;
  const version = options.version ?? defaultVersion;
  const tables = fumaSchema({
    version,
    tables: options.tables,
  }).tables as Record<string, AnyTable>;
  const statements = [
    ...Object.values(tables).map(createTableSql),
    ...Object.values(tables).flatMap((table) =>
      table.getUniqueConstraints().map((constraint) => createUniqueIndexSql(table, constraint)),
    ),
    createSettingsTableSql(namespace, version),
  ];

  const run = async (target: ExecutableDrizzleDb) => {
    for (const statement of statements) {
      await target.execute(sql.raw(statement));
    }
  };

  if (db.transaction) {
    await db.transaction(run);
  } else {
    await run(db);
  }
};
