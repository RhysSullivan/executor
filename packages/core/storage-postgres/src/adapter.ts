// ---------------------------------------------------------------------------
// @executor/storage-postgres — adapter implementation
//
// makePostgresAdapter(options) returns a DBAdapter that speaks postgres via
// an @effect/sql SqlClient (intended to be a @effect/sql-pg PgClient, but
// anything SqlClient-shaped works). SQL emitted is postgres-specific:
// JSONB for json columns, TIMESTAMPTZ for dates, native BOOLEAN, native
// arrays, SERIAL $N placeholders, multi-row INSERT VALUES, RETURNING.
//
// All dynamic SQL is built via sql.unsafe(sql, params) so that dynamic
// table/column identifiers can be interpolated as strings while values
// remain parameter-bound. Identifiers are quoted with quoteIdent.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { SqlClient } from "@effect/sql/SqlClient";
import type {
  DBAdapter,
  DBTransactionAdapter,
  DBSchema,
  Where,
  WhereOperator,
} from "@executor/storage-core";

// ---------------------------------------------------------------------------
// Identifier quoting — wraps in double quotes and escapes embedded quotes.
// Schemas defined in user code are trusted but we still quote to keep
// mixed-case and reserved-word table/column names working.
// ---------------------------------------------------------------------------

const quoteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------
// Schema -> column type mapping.
// ---------------------------------------------------------------------------

type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "string[]"
  | "number[]"
  | ReadonlyArray<string>;

const fieldTypeToSql = (type: FieldType): string => {
  if (Array.isArray(type)) return "TEXT"; // enum-as-array handled as text
  switch (type) {
    case "string":
      return "TEXT";
    case "number":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "TIMESTAMPTZ";
    case "json":
      return "JSONB";
    case "string[]":
      return "TEXT[]";
    case "number[]":
      return "DOUBLE PRECISION[]";
    default:
      return "TEXT";
  }
};

// Does the field type need an explicit cast when passed as a raw parameter?
const castForType = (type: FieldType): string | null => {
  if (Array.isArray(type)) return null;
  switch (type) {
    case "json":
      return "jsonb";
    case "date":
      return "timestamptz";
    case "string[]":
      return "text[]";
    case "number[]":
      return "double precision[]";
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// Value encoding: convert JS -> postgres-wire representation compatible
// with postgres.js's unsafe param path. JSON fields get stringified and
// cast to jsonb. Arrays get encoded as postgres array literals. Dates as
// ISO strings with explicit timestamptz cast.
// ---------------------------------------------------------------------------

const encodeArrayLiteral = (arr: ReadonlyArray<unknown>): string => {
  // Postgres array literal: {a,"b with , comma",NULL}
  const parts = arr.map((v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    const s = String(v);
    // Quote if contains whitespace, comma, brace, backslash, quote or is empty
    if (/[\s,{}\\"']/.test(s) || s.length === 0) {
      return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return s;
  });
  return `{${parts.join(",")}}`;
};

const encodeValue = (value: unknown, type: FieldType | undefined): unknown => {
  if (value === null || value === undefined) return null;
  if (type === "json") {
    return JSON.stringify(value);
  }
  if (type === "date") {
    if (value instanceof Date) return value.toISOString();
    return value;
  }
  if (type === "string[]" || type === "number[]") {
    if (Array.isArray(value)) return encodeArrayLiteral(value);
    return value;
  }
  return value;
};

// Decode values read from postgres. postgres.js already decodes JSONB to
// objects, timestamptz to Date, native arrays to arrays, booleans to
// booleans. So this is mostly a passthrough.
const decodeValue = (value: unknown, type: FieldType | undefined): unknown => {
  if (value === null || value === undefined) return value;
  if (type === "json" && typeof value === "string") {
    // Some drivers still hand back JSONB as string — parse if so.
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (type === "date" && typeof value === "string") {
    return new Date(value);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Where clause compilation: turn a Where[] into a SQL snippet + param
// list, with a running placeholder counter. Uses $N placeholders and
// combines clauses with the per-clause connector.
// ---------------------------------------------------------------------------

type Compiled = { sql: string; params: unknown[] };

const compileWhere = (
  where: readonly Where[] | undefined,
  fieldTypes: Record<string, FieldType>,
  startParam: number,
): Compiled => {
  if (!where || where.length === 0) return { sql: "", params: [] };
  const params: unknown[] = [];
  let n = startParam;
  const parts: string[] = [];

  for (let i = 0; i < where.length; i++) {
    const clause = where[i]!;
    const op: WhereOperator = clause.operator ?? "eq";
    const col = quoteIdent(clause.field);
    const type = fieldTypes[clause.field];
    const insensitive = clause.mode === "insensitive";

    let snippet = "";
    const pushParam = (v: unknown) => {
      const cast = castForType(type as FieldType);
      params.push(encodeValue(v, type));
      const ph = `$${n++}`;
      return cast ? `${ph}::${cast}` : ph;
    };
    const pushRawParam = (v: unknown) => {
      params.push(v);
      return `$${n++}`;
    };

    switch (op) {
      case "eq":
        if (clause.value === null) snippet = `${col} IS NULL`;
        else if (insensitive && typeof clause.value === "string") {
          snippet = `LOWER(${col}) = LOWER(${pushRawParam(clause.value)})`;
        } else snippet = `${col} = ${pushParam(clause.value)}`;
        break;
      case "ne":
        if (clause.value === null) snippet = `${col} IS NOT NULL`;
        else snippet = `${col} <> ${pushParam(clause.value)}`;
        break;
      case "lt":
        snippet = `${col} < ${pushParam(clause.value)}`;
        break;
      case "lte":
        snippet = `${col} <= ${pushParam(clause.value)}`;
        break;
      case "gt":
        snippet = `${col} > ${pushParam(clause.value)}`;
        break;
      case "gte":
        snippet = `${col} >= ${pushParam(clause.value)}`;
        break;
      case "in": {
        const arr = Array.isArray(clause.value) ? clause.value : [clause.value];
        if (arr.length === 0) {
          snippet = "FALSE";
        } else {
          const phs = arr.map((v) => pushParam(v)).join(", ");
          snippet = `${col} IN (${phs})`;
        }
        break;
      }
      case "not_in": {
        const arr = Array.isArray(clause.value) ? clause.value : [clause.value];
        if (arr.length === 0) {
          snippet = "TRUE";
        } else {
          const phs = arr.map((v) => pushParam(v)).join(", ");
          snippet = `${col} NOT IN (${phs})`;
        }
        break;
      }
      case "contains":
      case "starts_with":
      case "ends_with": {
        const raw = String(clause.value ?? "");
        const pattern =
          op === "contains"
            ? `%${raw}%`
            : op === "starts_with"
              ? `${raw}%`
              : `%${raw}`;
        const likeOp = insensitive ? "ILIKE" : "LIKE";
        snippet = `${col} ${likeOp} ${pushRawParam(pattern)}`;
        break;
      }
      default:
        snippet = "TRUE";
    }

    if (i === 0) {
      parts.push(snippet);
    } else {
      const conn = clause.connector === "OR" ? " OR " : " AND ";
      parts.push(`${conn}${snippet}`);
    }
  }

  return { sql: parts.join(""), params };
};

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

type ModelInfo = {
  tableName: string;
  // Map from logical field name -> physical column name
  columns: Record<string, string>;
  // Map from logical field name -> type
  types: Record<string, FieldType>;
  // Inverse: physical -> logical
  byColumn: Record<string, string>;
  // Ordered list of logical field names (excluding id)
  fields: string[];
  // Fields with an index: true flag
  indexedFields: string[];
  // Logical fields that are required
  required: Set<string>;
};

const buildModelInfo = (schema: DBSchema): Record<string, ModelInfo> => {
  const out: Record<string, ModelInfo> = {};
  for (const [model, def] of Object.entries(schema)) {
    const info: ModelInfo = {
      tableName: def.modelName,
      columns: { id: "id" },
      types: { id: "string" },
      byColumn: { id: "id" },
      fields: [],
      indexedFields: [],
      required: new Set(),
    };
    for (const [fname, field] of Object.entries(def.fields)) {
      const col = field.fieldName ?? fname;
      info.columns[fname] = col;
      info.types[fname] = field.type as FieldType;
      info.byColumn[col] = fname;
      info.fields.push(fname);
      if (field.index) info.indexedFields.push(fname);
      if (field.required !== false) info.required.add(fname);
    }
    out[model] = info;
  }
  return out;
};

// ---------------------------------------------------------------------------
// DDL: CREATE TABLE / CREATE INDEX from schema.
// ---------------------------------------------------------------------------

const buildCreateTableSql = (info: ModelInfo): string => {
  const colDefs: string[] = [`${quoteIdent("id")} TEXT PRIMARY KEY`];
  for (const fname of info.fields) {
    const col = info.columns[fname]!;
    const type = info.types[fname]!;
    const nullability = info.required.has(fname) ? " NOT NULL" : "";
    colDefs.push(`${quoteIdent(col)} ${fieldTypeToSql(type)}${nullability}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(info.tableName)} (${colDefs.join(", ")})`;
};

const buildCreateIndexSql = (info: ModelInfo): string[] => {
  return info.indexedFields.map((fname) => {
    const col = info.columns[fname]!;
    const idxName = `idx_${info.tableName}_${col}`;
    return `CREATE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(
      info.tableName,
    )} (${quoteIdent(col)})`;
  });
};

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

const generateId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Row decoding: rename physical -> logical and decode values by type.
// ---------------------------------------------------------------------------

const decodeRow = (
  raw: Record<string, unknown>,
  info: ModelInfo,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(raw)) {
    const logical = info.byColumn[col] ?? col;
    const type = info.types[logical];
    out[logical] = decodeValue(val, type);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Error wrapping: SqlClient returns SqlError which extends Error, but the
// DBAdapter interface is typed with Error. We widen via mapError.
// ---------------------------------------------------------------------------

const toError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(String(e));

// ---------------------------------------------------------------------------
// makePostgresAdapter
// ---------------------------------------------------------------------------

export interface MakePostgresAdapterOptions {
  readonly sql: SqlClient;
  readonly schema: DBSchema;
  readonly adapterId?: string;
}

export const makePostgresAdapter = (
  options: MakePostgresAdapterOptions,
): Effect.Effect<DBAdapter, Error> =>
  Effect.gen(function* () {
    const { sql } = options;
    const models = buildModelInfo(options.schema);
    const adapterId = options.adapterId ?? "postgres";

    // DDL: run CREATE TABLE / CREATE INDEX for each model.
    for (const info of Object.values(models)) {
      yield* sql
        .unsafe(buildCreateTableSql(info))
        .pipe(Effect.mapError(toError));
      for (const idxSql of buildCreateIndexSql(info)) {
        yield* sql.unsafe(idxSql).pipe(Effect.mapError(toError));
      }
    }

    const getModel = (model: string): ModelInfo => {
      const info = models[model];
      if (!info) throw new Error(`Unknown model: ${model}`);
      return info;
    };

    // Build column lists and value placeholders for INSERTs.
    const buildInsertSql = (
      info: ModelInfo,
      rows: ReadonlyArray<Record<string, unknown>>,
    ): Compiled => {
      // Collect the union of keys across all rows (in a stable order).
      const keyOrder: string[] = ["id", ...info.fields];
      const presentKeys = keyOrder.filter((k) =>
        rows.some((r) => k in r && r[k] !== undefined),
      );

      const cols = presentKeys.map((k) => quoteIdent(info.columns[k]!));
      const params: unknown[] = [];
      let n = 1;
      const valueRows: string[] = [];
      for (const row of rows) {
        const phs = presentKeys.map((k) => {
          const type = info.types[k];
          const cast = type ? castForType(type) : null;
          params.push(encodeValue(row[k], type));
          const ph = `$${n++}`;
          return cast ? `${ph}::${cast}` : ph;
        });
        valueRows.push(`(${phs.join(", ")})`);
      }

      const sqlStr = `INSERT INTO ${quoteIdent(info.tableName)} (${cols.join(
        ", ",
      )}) VALUES ${valueRows.join(", ")} RETURNING *`;
      return { sql: sqlStr, params };
    };

    const prepareRow = (
      info: ModelInfo,
      data: Record<string, unknown>,
      forceAllowId: boolean | undefined,
    ): Record<string, unknown> => {
      const row: Record<string, unknown> = { ...data };
      if (!forceAllowId && "id" in row) delete row.id;
      if (!row.id) row.id = generateId();
      // Filter down to known fields (+ id).
      const out: Record<string, unknown> = { id: row.id };
      for (const f of info.fields) {
        if (f in row) out[f] = row[f];
      }
      return out;
    };

    // -----------------------------------------------------------------------
    // Adapter method implementations.
    // -----------------------------------------------------------------------

    const doCreate = <T extends Record<string, unknown>, R = T>(data: {
      model: string;
      data: Omit<T, "id">;
      select?: string[] | undefined;
      forceAllowId?: boolean | undefined;
    }): Effect.Effect<R, Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const row = prepareRow(
          info,
          data.data as Record<string, unknown>,
          data.forceAllowId,
        );
        const compiled = buildInsertSql(info, [row]);
        const result = yield* sql
          .unsafe<Record<string, unknown>>(compiled.sql, compiled.params)
          .pipe(Effect.mapError(toError));
        const first = (result as ReadonlyArray<Record<string, unknown>>)[0];
        if (!first) throw new Error("INSERT returned no rows");
        return decodeRow(first, info) as unknown as R;
      });

    const doCreateMany = <T extends Record<string, unknown>, R = T>(data: {
      model: string;
      data: ReadonlyArray<Omit<T, "id">>;
      forceAllowId?: boolean | undefined;
    }): Effect.Effect<readonly R[], Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        if (data.data.length === 0) return [] as R[];
        const rows = data.data.map((d) =>
          prepareRow(info, d as Record<string, unknown>, data.forceAllowId),
        );
        const compiled = buildInsertSql(info, rows);
        const result = yield* sql
          .unsafe<Record<string, unknown>>(compiled.sql, compiled.params)
          .pipe(Effect.mapError(toError));
        return (result as ReadonlyArray<Record<string, unknown>>).map(
          (r) => decodeRow(r, info) as unknown as R,
        );
      });

    const doFindMany = <T>(data: {
      model: string;
      where?: Where[] | undefined;
      limit?: number | undefined;
      select?: string[] | undefined;
      sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
      offset?: number | undefined;
    }): Effect.Effect<T[], Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const selectCols =
          data.select && data.select.length > 0
            ? data.select.map((f) => quoteIdent(info.columns[f] ?? f)).join(", ")
            : "*";
        const whereCompiled = compileWhere(data.where, info.types, 1);
        const whereSql = whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : "";
        let orderSql = "";
        if (data.sortBy) {
          const col = quoteIdent(info.columns[data.sortBy.field] ?? data.sortBy.field);
          const dir = data.sortBy.direction === "desc" ? "DESC" : "ASC";
          orderSql = ` ORDER BY ${col} ${dir}`;
        }
        const limitSql = data.limit !== undefined ? ` LIMIT ${Math.floor(data.limit)}` : "";
        const offsetSql = data.offset ? ` OFFSET ${Math.floor(data.offset)}` : "";

        const sqlStr = `SELECT ${selectCols} FROM ${quoteIdent(
          info.tableName,
        )}${whereSql}${orderSql}${limitSql}${offsetSql}`;
        const result = yield* sql
          .unsafe<Record<string, unknown>>(sqlStr, whereCompiled.params)
          .pipe(Effect.mapError(toError));
        return (result as ReadonlyArray<Record<string, unknown>>).map(
          (r) => decodeRow(r, info) as unknown as T,
        );
      });

    const doFindOne = <T>(data: {
      model: string;
      where: Where[];
      select?: string[] | undefined;
    }): Effect.Effect<T | null, Error> =>
      Effect.gen(function* () {
        const rows = yield* doFindMany<T>({ ...data, limit: 1 });
        return rows[0] ?? null;
      });

    const doCount = (data: {
      model: string;
      where?: Where[] | undefined;
    }): Effect.Effect<number, Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const whereCompiled = compileWhere(data.where, info.types, 1);
        const whereSql = whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : "";
        const sqlStr = `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(
          info.tableName,
        )}${whereSql}`;
        const result = yield* sql
          .unsafe<{ count: string | number | bigint }>(
            sqlStr,
            whereCompiled.params,
          )
          .pipe(Effect.mapError(toError));
        const arr = result as ReadonlyArray<{ count: string | number | bigint }>;
        const raw = arr[0]?.count ?? 0;
        return typeof raw === "number" ? raw : Number(raw);
      });

    const buildSetClause = (
      info: ModelInfo,
      update: Record<string, unknown>,
      startParam: number,
    ): Compiled => {
      const keys = Object.keys(update).filter(
        (k) => k in info.columns && k !== "id",
      );
      const params: unknown[] = [];
      let n = startParam;
      const parts = keys.map((k) => {
        const col = quoteIdent(info.columns[k]!);
        const type = info.types[k];
        const cast = type ? castForType(type) : null;
        params.push(encodeValue(update[k], type));
        const ph = `$${n++}`;
        return `${col} = ${cast ? `${ph}::${cast}` : ph}`;
      });
      return { sql: parts.join(", "), params };
    };

    const doUpdateMany = (data: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Effect.Effect<number, Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const set = buildSetClause(info, data.update, 1);
        if (!set.sql) return 0;
        const whereCompiled = compileWhere(
          data.where,
          info.types,
          set.params.length + 1,
        );
        const whereSql = whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : "";
        const sqlStr = `UPDATE ${quoteIdent(info.tableName)} SET ${set.sql}${whereSql}`;
        const params = [...set.params, ...whereCompiled.params];
        // postgres.js unsafe doesn't expose rowCount directly; use RETURNING to
        // count affected rows.
        const withReturning = `${sqlStr} RETURNING id`;
        const result = yield* sql
          .unsafe<{ id: string }>(withReturning, params)
          .pipe(Effect.mapError(toError));
        return (result as ReadonlyArray<unknown>).length;
      });

    const doUpdate = <T>(data: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Effect.Effect<T | null, Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const set = buildSetClause(info, data.update, 1);
        if (!set.sql) return null;
        const whereCompiled = compileWhere(
          data.where,
          info.types,
          set.params.length + 1,
        );
        const whereSql = whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : "";
        const sqlStr = `UPDATE ${quoteIdent(info.tableName)} SET ${set.sql}${whereSql} RETURNING *`;
        const params = [...set.params, ...whereCompiled.params];
        const result = yield* sql
          .unsafe<Record<string, unknown>>(sqlStr, params)
          .pipe(Effect.mapError(toError));
        const arr = result as ReadonlyArray<Record<string, unknown>>;
        if (arr.length !== 1) return null;
        return decodeRow(arr[0]!, info) as unknown as T;
      });

    const doDelete = (data: {
      model: string;
      where: Where[];
    }): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const whereCompiled = compileWhere(data.where, info.types, 1);
        const whereSql = whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : "";
        // Delete a single matching row — mirror in-memory semantics by
        // using a CTE with LIMIT 1.
        const sqlStr = `DELETE FROM ${quoteIdent(info.tableName)} WHERE ${quoteIdent(
          "id",
        )} IN (SELECT ${quoteIdent("id")} FROM ${quoteIdent(
          info.tableName,
        )}${whereSql} LIMIT 1)`;
        yield* sql
          .unsafe(sqlStr, whereCompiled.params)
          .pipe(Effect.mapError(toError));
      });

    const doDeleteMany = (data: {
      model: string;
      where: Where[];
    }): Effect.Effect<number, Error> =>
      Effect.gen(function* () {
        const info = getModel(data.model);
        const whereCompiled = compileWhere(data.where, info.types, 1);
        const whereSql = whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : "";
        const sqlStr = `DELETE FROM ${quoteIdent(
          info.tableName,
        )}${whereSql} RETURNING id`;
        const result = yield* sql
          .unsafe<{ id: string }>(sqlStr, whereCompiled.params)
          .pipe(Effect.mapError(toError));
        return (result as ReadonlyArray<unknown>).length;
      });

    const adapter: DBAdapter = {
      id: adapterId,
      create: doCreate,
      createMany: doCreateMany,
      findOne: doFindOne,
      findMany: doFindMany,
      count: doCount,
      update: doUpdate,
      updateMany: doUpdateMany,
      delete: doDelete,
      deleteMany: doDeleteMany,
      transaction: <R, E>(
        callback: (trx: DBTransactionAdapter) => Effect.Effect<R, E>,
      ): Effect.Effect<R, E | Error> =>
        sql
          .withTransaction(callback(adapter))
          .pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e))))) as Effect.Effect<R, E | Error>,
    };

    return adapter;
  });
