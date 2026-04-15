// ---------------------------------------------------------------------------
// makeSqliteAdapter — a DBAdapter implementation backed by @effect/sql
//
// Auto-generates SQLite tables from a DBSchema at construction time, then
// translates every DBAdapter method into SQL. Handles type coercion for
// json / date / boolean columns on both read and write paths. Implements
// transactions via BEGIN / COMMIT / ROLLBACK (delegated to SqlClient's
// built-in withTransaction helper).
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type * as SqlClient from "@effect/sql/SqlClient";
import type { Fragment } from "@effect/sql/Statement";
import type {
  DBAdapter,
  DBSchema,
  DBFieldAttribute,
  DBFieldType,
  Where,
} from "@executor/storage-core";

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

interface ModelInfo {
  readonly modelName: string; // physical table name
  readonly fields: Record<string, DBFieldAttribute>; // logical field name -> attribute
}

const getModelInfo = (
  schema: DBSchema,
  model: string,
): ModelInfo => {
  const entry = schema[model];
  if (!entry) {
    throw new Error(`[storage-file] unknown model "${model}"`);
  }
  return { modelName: entry.modelName ?? model, fields: entry.fields };
};

const physicalColumn = (
  fields: Record<string, DBFieldAttribute>,
  logical: string,
): string => {
  if (logical === "id") return "id";
  return fields[logical]?.fieldName ?? logical;
};

const fieldTypeOf = (
  fields: Record<string, DBFieldAttribute>,
  logical: string,
): DBFieldType | "id" => {
  if (logical === "id") return "id";
  return fields[logical]?.type ?? "string";
};

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

const encodeValue = (type: DBFieldType | "id", value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (type === "id") return value;
  switch (type) {
    case "boolean":
      return value ? 1 : 0;
    case "date":
      if (value instanceof Date) return value.toISOString();
      return value;
    case "json":
      return JSON.stringify(value);
    case "number":
    case "string":
      return value;
    default:
      // arrays / string[] / number[] — serialize as JSON
      return JSON.stringify(value);
  }
};

const decodeValue = (type: DBFieldType | "id", value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (type === "id") return value;
  switch (type) {
    case "boolean":
      return value === 1 || value === true || value === "1";
    case "date":
      return typeof value === "string" ? new Date(value) : value;
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "number":
      return typeof value === "string" ? Number(value) : value;
    case "string":
      return value;
    default:
      return typeof value === "string" ? JSON.parse(value) : value;
  }
};

const decodeRow = (
  info: ModelInfo,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  // id is always present
  if ("id" in row) out.id = row.id;
  for (const [logical, attr] of Object.entries(info.fields)) {
    const physical = attr.fieldName ?? logical;
    if (physical in row) {
      out[logical] = decodeValue(attr.type, row[physical]);
    }
  }
  return out;
};

const encodeData = (
  info: ModelInfo,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "id") {
      out.id = value;
      continue;
    }
    const attr = info.fields[key];
    if (!attr) continue; // silently drop unknown fields
    const physical = attr.fieldName ?? key;
    out[physical] = encodeValue(attr.type, value);
  }
  return out;
};

// ---------------------------------------------------------------------------
// DDL generation — CREATE TABLE IF NOT EXISTS
// ---------------------------------------------------------------------------

const sqlTypeFor = (type: DBFieldType): string => {
  switch (type) {
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    case "date":
      return "TEXT";
    case "json":
      return "TEXT";
    case "string":
      return "TEXT";
    default:
      return "TEXT"; // arrays
  }
};

const buildCreateTableSql = (
  modelName: string,
  fields: Record<string, DBFieldAttribute>,
): string => {
  const cols: string[] = [`"id" TEXT PRIMARY KEY NOT NULL`];
  for (const [logical, attr] of Object.entries(fields)) {
    const name = attr.fieldName ?? logical;
    const type = sqlTypeFor(attr.type);
    const parts: string[] = [`"${name}" ${type}`];
    if (attr.required !== false && attr.defaultValue === undefined) {
      // Do not mark NOT NULL — upstream validates, and this keeps us forgiving
      // against defaults-applied-in-app.
    }
    if (attr.unique) parts.push("UNIQUE");
    cols.push(parts.join(" "));
  }
  return `CREATE TABLE IF NOT EXISTS "${modelName}" (${cols.join(", ")})`;
};

const buildIndexSql = (
  modelName: string,
  fields: Record<string, DBFieldAttribute>,
): string[] => {
  const out: string[] = [];
  for (const [logical, attr] of Object.entries(fields)) {
    if (!attr.index) continue;
    const col = attr.fieldName ?? logical;
    out.push(
      `CREATE INDEX IF NOT EXISTS "idx_${modelName}_${col}" ON "${modelName}" ("${col}")`,
    );
  }
  return out;
};

// ---------------------------------------------------------------------------
// Where clause compiler — Where[] -> SQL fragment
//
// Matches storage-memory semantics: AND/OR flattened left-to-right, with
// case-insensitive string comparisons via LOWER() when mode="insensitive".
// ---------------------------------------------------------------------------

const buildWhereFragment = (
  sql: SqlClient.SqlClient,
  info: ModelInfo,
  where: readonly Where[] | undefined,
): Fragment | null => {
  if (!where || where.length === 0) return null;

  const compileClause = (clause: Where): Fragment => {
    const logical = clause.field;
    const physical = physicalColumn(info.fields, logical);
    const type = fieldTypeOf(info.fields, logical);
    const op = clause.operator ?? "eq";
    const mode = clause.mode ?? "sensitive";
    const insensitive = mode === "insensitive";

    const colId = sql(physical);

    // Encode RHS the same way we'd store it, so comparisons line up with
    // how rows were written.
    const encode = (v: unknown): unknown => {
      if (type === "id") return v;
      if (v === null || v === undefined) return v;
      if (Array.isArray(v)) return v.map((x) => encodeValue(type, x));
      return encodeValue(type, v);
    };

    const rhs = encode(clause.value);

    const lowered = (f: Fragment) =>
      insensitive ? sql`LOWER(${f})` : f;

    const lhsFrag = lowered(sql`${colId}`);
    const loweredVal = (v: unknown): Fragment =>
      insensitive && typeof v === "string" ? sql`LOWER(${v})` : sql`${v}`;

    switch (op) {
      case "eq":
        if (rhs === null) return sql`${colId} IS NULL`;
        return sql`${lhsFrag} = ${loweredVal(rhs)}`;
      case "ne":
        if (rhs === null) return sql`${colId} IS NOT NULL`;
        return sql`${lhsFrag} <> ${loweredVal(rhs)}`;
      case "lt":
        return sql`${colId} < ${rhs}`;
      case "lte":
        return sql`${colId} <= ${rhs}`;
      case "gt":
        return sql`${colId} > ${rhs}`;
      case "gte":
        return sql`${colId} >= ${rhs}`;
      case "in": {
        const arr = Array.isArray(rhs) ? rhs : [];
        if (arr.length === 0) return sql`1 = 0`;
        return sql`${colId} IN ${sql.in(arr)}`;
      }
      case "not_in": {
        const arr = Array.isArray(rhs) ? rhs : [];
        if (arr.length === 0) return sql`1 = 1`;
        return sql`${colId} NOT IN ${sql.in(arr)}`;
      }
      case "contains":
        return sql`${lhsFrag} LIKE ${loweredVal(`%${String(rhs)}%`)}`;
      case "starts_with":
        return sql`${lhsFrag} LIKE ${loweredVal(`${String(rhs)}%`)}`;
      case "ends_with":
        return sql`${lhsFrag} LIKE ${loweredVal(`%${String(rhs)}`)}`;
      default:
        return sql`1 = 1`;
    }
  };

  // Left-to-right combination: for each clause after the first, if its
  // connector is "OR" combine with OR, else AND. Matches matchRow.
  let acc = compileClause(where[0]!);
  for (let i = 1; i < where.length; i++) {
    const clause = where[i]!;
    const next = compileClause(clause);
    acc =
      clause.connector === "OR"
        ? sql`(${acc}) OR (${next})`
        : sql`(${acc}) AND (${next})`;
  }
  return acc;
};

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

const generateId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface MakeSqliteAdapterOptions {
  readonly sql: SqlClient.SqlClient;
  readonly schema: DBSchema;
  readonly adapterId?: string;
  readonly generateId?: () => string;
}

export const makeSqliteAdapter = (
  options: MakeSqliteAdapterOptions,
): Effect.Effect<DBAdapter, Error> =>
  Effect.gen(function* () {
    const { sql, schema } = options;
    const idGen = options.generateId ?? generateId;
    const adapterId = options.adapterId ?? "sqlite";

    // Ensure tables + indexes exist. Ordered by `order` hint if present.
    const modelEntries = Object.entries(schema)
      .filter(([, def]) => def.disableMigrations !== true)
      .sort(
        ([, a], [, b]) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER),
      );

    for (const [, def] of modelEntries) {
      const physical = def.modelName;
      const ddl = buildCreateTableSql(physical, def.fields);
      yield* sql.unsafe(ddl).pipe(
        Effect.mapError((e) => new Error(`[storage-file] ${String(e)}`)),
      );
      for (const idx of buildIndexSql(physical, def.fields)) {
        yield* sql.unsafe(idx).pipe(
          Effect.mapError((e) => new Error(`[storage-file] ${String(e)}`)),
        );
      }
    }

    const toErr = <A>(
      eff: Effect.Effect<A, unknown>,
    ): Effect.Effect<A, Error> =>
      eff.pipe(
        Effect.mapError((e) =>
          e instanceof Error ? e : new Error(String(e)),
        ),
      );

    const insertRow = (
      model: string,
      input: Record<string, unknown>,
      forceAllowId: boolean,
    ): Effect.Effect<Record<string, unknown>, Error> =>
      Effect.gen(function* () {
        const info = getModelInfo(schema, model);
        const row: Record<string, unknown> = { ...input };
        if (!forceAllowId || row.id === undefined || row.id === null) {
          if (row.id === undefined || row.id === null) row.id = idGen();
        }
        const encoded = encodeData(info, row);
        // Make sure id is included
        if (encoded.id === undefined) encoded.id = row.id;
        const tbl = sql(info.modelName);
        yield* toErr(sql`INSERT INTO ${tbl} ${sql.insert(encoded)}`);
        // Return the decoded logical row
        return decodeRow(info, encoded);
      });

    const self: DBAdapter = {
      id: adapterId,

      create: <T extends Record<string, unknown>, R = T>(data: {
        model: string;
        data: Omit<T, "id">;
        select?: string[] | undefined;
        forceAllowId?: boolean | undefined;
      }) =>
        insertRow(
          data.model,
          data.data as Record<string, unknown>,
          data.forceAllowId === true,
        ) as Effect.Effect<R, Error>,

      createMany: <T extends Record<string, unknown>, R = T>(data: {
        model: string;
        data: ReadonlyArray<Omit<T, "id">>;
        forceAllowId?: boolean | undefined;
      }) =>
        Effect.gen(function* () {
          const out: Record<string, unknown>[] = [];
          for (const input of data.data) {
            const row = yield* insertRow(
              data.model,
              input as Record<string, unknown>,
              data.forceAllowId === true,
            );
            out.push(row);
          }
          return out as unknown as readonly R[];
        }),

      findOne: <T>(data: {
        model: string;
        where: Where[];
        select?: string[] | undefined;
      }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);
          const query = whereFrag
            ? sql<Record<string, unknown>>`SELECT * FROM ${tbl} WHERE ${whereFrag} LIMIT 1`
            : sql<Record<string, unknown>>`SELECT * FROM ${tbl} LIMIT 1`;
          const rows = yield* toErr(query);
          const row = rows[0];
          return row ? (decodeRow(info, row) as unknown as T) : null;
        }),

      findMany: <T>(data: {
        model: string;
        where?: Where[] | undefined;
        limit?: number | undefined;
        select?: string[] | undefined;
        sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
        offset?: number | undefined;
      }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);

          const orderFrag = data.sortBy
            ? (() => {
                const col = physicalColumn(info.fields, data.sortBy!.field);
                const dir = data.sortBy!.direction === "asc" ? "ASC" : "DESC";
                return sql` ORDER BY ${sql(col)} ${sql.unsafe(dir)}`;
              })()
            : sql``;
          // SQLite requires LIMIT whenever OFFSET is present. Fall back
          // to -1 (= unlimited) so offset-only queries still work.
          const needsLimit =
            data.limit !== undefined || data.offset !== undefined;
          const limitFrag = needsLimit
            ? sql` LIMIT ${data.limit ?? -1}`
            : sql``;
          const offsetFrag =
            data.offset !== undefined ? sql` OFFSET ${data.offset}` : sql``;

          const query = whereFrag
            ? sql<
                Record<string, unknown>
              >`SELECT * FROM ${tbl} WHERE ${whereFrag}${orderFrag}${limitFrag}${offsetFrag}`
            : sql<
                Record<string, unknown>
              >`SELECT * FROM ${tbl}${orderFrag}${limitFrag}${offsetFrag}`;

          const rows = yield* toErr(query);
          return rows.map(
            (r) => decodeRow(info, r) as unknown as T,
          ) as T[];
        }),

      count: (data: { model: string; where?: Where[] | undefined }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);
          const query = whereFrag
            ? sql<{
                c: number;
              }>`SELECT COUNT(*) as c FROM ${tbl} WHERE ${whereFrag}`
            : sql<{ c: number }>`SELECT COUNT(*) as c FROM ${tbl}`;
          const rows = yield* toErr(query);
          return Number(rows[0]?.c ?? 0);
        }),

      update: <T>(data: {
        model: string;
        where: Where[];
        update: Record<string, unknown>;
      }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);

          // First find matching rows — if >1 we return null per the
          // DBAdapter contract. Select only id to keep this cheap.
          const selectQuery = whereFrag
            ? sql<{
                id: string;
              }>`SELECT id FROM ${tbl} WHERE ${whereFrag} LIMIT 2`
            : sql<{ id: string }>`SELECT id FROM ${tbl} LIMIT 2`;
          const found = yield* toErr(selectQuery);
          if (found.length === 0) return null;
          if (found.length > 1) return null;

          const targetId = found[0]!.id;
          const encoded = encodeData(info, data.update);
          // Drop id from update payload — never rewrite it.
          delete encoded.id;
          if (Object.keys(encoded).length > 0) {
            yield* toErr(
              sql`UPDATE ${tbl} SET ${sql.update(encoded)} WHERE ${sql("id")} = ${targetId}`,
            );
          }
          const rows = yield* toErr(
            sql<
              Record<string, unknown>
            >`SELECT * FROM ${tbl} WHERE ${sql("id")} = ${targetId} LIMIT 1`,
          );
          const row = rows[0];
          return row ? (decodeRow(info, row) as unknown as T) : null;
        }),

      updateMany: (data: {
        model: string;
        where: Where[];
        update: Record<string, unknown>;
      }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);
          const encoded = encodeData(info, data.update);
          delete encoded.id;
          if (Object.keys(encoded).length === 0) {
            // nothing to do — return count of matching rows
            const countQ = whereFrag
              ? sql<{
                  c: number;
                }>`SELECT COUNT(*) as c FROM ${tbl} WHERE ${whereFrag}`
              : sql<{ c: number }>`SELECT COUNT(*) as c FROM ${tbl}`;
            const rows = yield* toErr(countQ);
            return Number(rows[0]?.c ?? 0);
          }
          // Count matched first, then update.
          const countQ = whereFrag
            ? sql<{
                c: number;
              }>`SELECT COUNT(*) as c FROM ${tbl} WHERE ${whereFrag}`
            : sql<{ c: number }>`SELECT COUNT(*) as c FROM ${tbl}`;
          const countRows = yield* toErr(countQ);
          const n = Number(countRows[0]?.c ?? 0);
          const updateQ = whereFrag
            ? sql`UPDATE ${tbl} SET ${sql.update(encoded)} WHERE ${whereFrag}`
            : sql`UPDATE ${tbl} SET ${sql.update(encoded)}`;
          yield* toErr(updateQ);
          return n;
        }),

      delete: (data: { model: string; where: Where[] }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);
          // storage-memory's delete only removes the first match. Mirror that.
          const selectQuery = whereFrag
            ? sql<{
                id: string;
              }>`SELECT id FROM ${tbl} WHERE ${whereFrag} LIMIT 1`
            : sql<{ id: string }>`SELECT id FROM ${tbl} LIMIT 1`;
          const found = yield* toErr(selectQuery);
          if (found.length === 0) return;
          yield* toErr(
            sql`DELETE FROM ${tbl} WHERE ${sql("id")} = ${found[0]!.id}`,
          );
        }),

      deleteMany: (data: { model: string; where: Where[] }) =>
        Effect.gen(function* () {
          const info = getModelInfo(schema, data.model);
          const tbl = sql(info.modelName);
          const whereFrag = buildWhereFragment(sql, info, data.where);
          const countQ = whereFrag
            ? sql<{
                c: number;
              }>`SELECT COUNT(*) as c FROM ${tbl} WHERE ${whereFrag}`
            : sql<{ c: number }>`SELECT COUNT(*) as c FROM ${tbl}`;
          const countRows = yield* toErr(countQ);
          const n = Number(countRows[0]?.c ?? 0);
          const delQ = whereFrag
            ? sql`DELETE FROM ${tbl} WHERE ${whereFrag}`
            : sql`DELETE FROM ${tbl}`;
          yield* toErr(delQ);
          return n;
        }),

      // SqlClient.withTransaction runs the effect inside BEGIN/COMMIT and
      // rolls back on any failure. It only tracks the current fiber's SQL
      // operations, so we can safely expose the same `self` as the trx
      // argument — nothing else is scoped.
      transaction: <R, E>(
        callback: (trx: Omit<DBAdapter, "transaction">) => Effect.Effect<R, E>,
      ) =>
        sql.withTransaction(callback(self)).pipe(
          Effect.mapError((e) =>
            e instanceof Error ? (e as E | Error) : new Error(String(e)),
          ),
        ),
    };

    return self;
  });
