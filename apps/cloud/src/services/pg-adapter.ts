// ---------------------------------------------------------------------------
// apps/cloud pg-adapter — postgres.js-based DBAdapter
// ---------------------------------------------------------------------------
//
// Structurally ported from @executor/storage-postgres's @effect/sql-pg-based
// adapter, with the execution layer swapped to `postgres` (porsager). We
// need this inline because apps/cloud runs in Cloudflare Workers +
// Hyperdrive, which requires fresh per-request DB connections —
// @effect/sql-pg's lifecycle model doesn't play nicely with that constraint.
//
// SQL dialect emitted is postgres-specific: JSONB for json columns,
// TIMESTAMPTZ for dates, native BOOLEAN, native arrays, $N placeholders,
// multi-row INSERT VALUES, RETURNING. All dynamic SQL goes through
// `sql.unsafe(sqlStr, params)` — identifiers are interpolated as string
// fragments, values stay parameter-bound.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { Sql, TransactionSql } from "postgres";

import type {
  DBAdapter,
  DBTransactionAdapter,
  DBSchema,
  Where,
  WhereOperator,
} from "@executor/storage-core";

// ---------------------------------------------------------------------------
// Identifier quoting
// ---------------------------------------------------------------------------

const quoteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------
// Schema -> column type mapping
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
// Value encoding (JS -> postgres.js wire). postgres.js handles Date,
// booleans, arrays, and JSONB on its own — we mostly stringify JSON and
// let the driver handle everything else.
// ---------------------------------------------------------------------------

const encodeValue = (value: unknown, type: FieldType | undefined): unknown => {
  if (value === null || value === undefined) return null;
  if (type === "json") return JSON.stringify(value);
  return value;
};

const decodeValue = (value: unknown, type: FieldType | undefined): unknown => {
  if (value === null || value === undefined) return value;
  if (type === "json" && typeof value === "string") {
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
// Where clause compilation -> SQL snippet + param list
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
        const arr: unknown[] = Array.isArray(clause.value)
          ? (clause.value as unknown[])
          : [clause.value];
        if (arr.length === 0) {
          snippet = "FALSE";
        } else {
          const phs = arr.map((v: unknown) => pushParam(v)).join(", ");
          snippet = `${col} IN (${phs})`;
        }
        break;
      }
      case "not_in": {
        const arr: unknown[] = Array.isArray(clause.value)
          ? (clause.value as unknown[])
          : [clause.value];
        if (arr.length === 0) {
          snippet = "TRUE";
        } else {
          const phs = arr.map((v: unknown) => pushParam(v)).join(", ");
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
  columns: Record<string, string>;
  types: Record<string, FieldType>;
  byColumn: Record<string, string>;
  fields: string[];
  indexedFields: string[];
  required: Set<string>;
};

const buildModelInfo = (schema: DBSchema): Record<string, ModelInfo> => {
  const out: Record<string, ModelInfo> = {};
  for (const model of Object.keys(schema)) {
    const def = schema[model]!;
    const info: ModelInfo = {
      tableName: def.modelName,
      columns: { id: "id" },
      types: { id: "string" },
      byColumn: { id: "id" },
      fields: [],
      indexedFields: [],
      required: new Set(),
    };
    for (const fname of Object.keys(def.fields)) {
      // Skip any explicit `id` field — it's always emitted first as the
      // primary key, and re-emitting would produce a duplicate column.
      if (fname === "id") continue;
      const field = def.fields[fname]!;
      const col = field.fieldName ?? fname;
      if (col === "id") continue;
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
// DDL
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
// Row decoding: rename physical -> logical and decode values
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
// Error wrapping
// ---------------------------------------------------------------------------

const wrapErr =
  (op: string) =>
  (e: unknown): Error => {
    const msg = e instanceof Error ? e.message : String(e);
    return new Error(`[pg-adapter] ${op}: ${msg}`);
  };

// ---------------------------------------------------------------------------
// makePgAdapter
// ---------------------------------------------------------------------------

// Narrow helper: the ISql-shaped callable that Sql and TransactionSql both
// satisfy for the operations we need (`.unsafe`).
type PgClient = Pick<Sql, "unsafe" | "begin"> | TransactionSql;

export interface MakePgAdapterOptions {
  readonly sql: Sql;
  readonly schema: DBSchema;
  readonly adapterId?: string;
}

export const makePgAdapter = (
  options: MakePgAdapterOptions,
): Effect.Effect<DBAdapter, Error> =>
  Effect.gen(function* () {
    const { sql: rootSql } = options;
    const models = buildModelInfo(options.schema);
    const adapterId = options.adapterId ?? "postgres";

    // DDL: CREATE TABLE / CREATE INDEX for each model on the root sql.
    for (const info of Object.values(models)) {
      yield* Effect.tryPromise({
        try: () => rootSql.unsafe(buildCreateTableSql(info)),
        catch: wrapErr(`DDL CREATE TABLE ${info.tableName}`),
      });
      for (const idxSql of buildCreateIndexSql(info)) {
        yield* Effect.tryPromise({
          try: () => rootSql.unsafe(idxSql),
          catch: wrapErr(`DDL CREATE INDEX ${info.tableName}`),
        });
      }
    }

    const getModel = (model: string): ModelInfo => {
      const info = models[model];
      if (!info) throw new Error(`[pg-adapter] Unknown model: ${model}`);
      return info;
    };

    const buildInsertSql = (
      info: ModelInfo,
      rows: ReadonlyArray<Record<string, unknown>>,
    ): Compiled => {
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
      const out: Record<string, unknown> = { id: row.id };
      for (const f of info.fields) {
        if (f in row) out[f] = row[f];
      }
      return out;
    };

    // -----------------------------------------------------------------------
    // Adapter builder — takes a client (root or a transactional tx) and
    // returns a DBAdapter bound to it. The root adapter exposes
    // transaction(); transactional adapters don't need it (their surface
    // is DBTransactionAdapter).
    // -----------------------------------------------------------------------

    const buildAdapter = (client: PgClient): DBAdapter => {
      const runUnsafe = <T = Record<string, unknown>>(
        op: string,
        sqlStr: string,
        params: unknown[],
      ): Effect.Effect<ReadonlyArray<T>, Error> =>
        Effect.tryPromise({
          try: () =>
            // postgres.js's `unsafe` returns a PendingQuery awaitable for an
            // array of rows. We coerce through `any` to avoid the strict
            // `ParameterOrJSON<never>[]` typing which can't be satisfied
            // from mixed JS values.
            (
              client.unsafe(
                sqlStr,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                params as any,
              ) as unknown as Promise<ReadonlyArray<T>>
            ),
          catch: wrapErr(op),
        });

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
          const result = yield* runUnsafe<Record<string, unknown>>(
            `create ${info.tableName}`,
            compiled.sql,
            compiled.params,
          );
          const first = result[0];
          if (!first)
            return yield* Effect.fail(
              new Error(`[pg-adapter] create ${info.tableName}: no rows returned`),
            );
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
          const result = yield* runUnsafe<Record<string, unknown>>(
            `createMany ${info.tableName}`,
            compiled.sql,
            compiled.params,
          );
          return result.map((r) => decodeRow(r, info) as unknown as R);
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
              ? data.select
                  .map((f) => quoteIdent(info.columns[f] ?? f))
                  .join(", ")
              : "*";
          const whereCompiled = compileWhere(data.where, info.types, 1);
          const whereSql = whereCompiled.sql
            ? ` WHERE ${whereCompiled.sql}`
            : "";
          let orderSql = "";
          if (data.sortBy) {
            const col = quoteIdent(
              info.columns[data.sortBy.field] ?? data.sortBy.field,
            );
            const dir = data.sortBy.direction === "desc" ? "DESC" : "ASC";
            orderSql = ` ORDER BY ${col} ${dir}`;
          }
          const limitSql =
            data.limit !== undefined ? ` LIMIT ${Math.floor(data.limit)}` : "";
          const offsetSql = data.offset
            ? ` OFFSET ${Math.floor(data.offset)}`
            : "";

          const sqlStr = `SELECT ${selectCols} FROM ${quoteIdent(
            info.tableName,
          )}${whereSql}${orderSql}${limitSql}${offsetSql}`;
          const result = yield* runUnsafe<Record<string, unknown>>(
            `findMany ${info.tableName}`,
            sqlStr,
            whereCompiled.params,
          );
          return result.map((r) => decodeRow(r, info) as unknown as T);
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
          const whereSql = whereCompiled.sql
            ? ` WHERE ${whereCompiled.sql}`
            : "";
          const sqlStr = `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(
            info.tableName,
          )}${whereSql}`;
          const result = yield* runUnsafe<{
            count: string | number | bigint;
          }>(`count ${info.tableName}`, sqlStr, whereCompiled.params);
          const raw = result[0]?.count ?? 0;
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
          const whereSql = whereCompiled.sql
            ? ` WHERE ${whereCompiled.sql}`
            : "";
          const sqlStr = `UPDATE ${quoteIdent(info.tableName)} SET ${set.sql}${whereSql} RETURNING id`;
          const params = [...set.params, ...whereCompiled.params];
          const result = yield* runUnsafe<{ id: string }>(
            `updateMany ${info.tableName}`,
            sqlStr,
            params,
          );
          return result.length;
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
          const whereSql = whereCompiled.sql
            ? ` WHERE ${whereCompiled.sql}`
            : "";
          const sqlStr = `UPDATE ${quoteIdent(info.tableName)} SET ${set.sql}${whereSql} RETURNING *`;
          const params = [...set.params, ...whereCompiled.params];
          const result = yield* runUnsafe<Record<string, unknown>>(
            `update ${info.tableName}`,
            sqlStr,
            params,
          );
          if (result.length !== 1) return null;
          return decodeRow(result[0]!, info) as unknown as T;
        });

      const doDelete = (data: {
        model: string;
        where: Where[];
      }): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const info = getModel(data.model);
          const whereCompiled = compileWhere(data.where, info.types, 1);
          const whereSql = whereCompiled.sql
            ? ` WHERE ${whereCompiled.sql}`
            : "";
          // Delete a single matching row — mirror in-memory semantics by
          // using a subquery with LIMIT 1.
          const sqlStr = `DELETE FROM ${quoteIdent(info.tableName)} WHERE ${quoteIdent(
            "id",
          )} IN (SELECT ${quoteIdent("id")} FROM ${quoteIdent(
            info.tableName,
          )}${whereSql} LIMIT 1)`;
          yield* runUnsafe(
            `delete ${info.tableName}`,
            sqlStr,
            whereCompiled.params,
          );
        });

      const doDeleteMany = (data: {
        model: string;
        where: Where[];
      }): Effect.Effect<number, Error> =>
        Effect.gen(function* () {
          const info = getModel(data.model);
          const whereCompiled = compileWhere(data.where, info.types, 1);
          const whereSql = whereCompiled.sql
            ? ` WHERE ${whereCompiled.sql}`
            : "";
          const sqlStr = `DELETE FROM ${quoteIdent(
            info.tableName,
          )}${whereSql} RETURNING id`;
          const result = yield* runUnsafe<{ id: string }>(
            `deleteMany ${info.tableName}`,
            sqlStr,
            whereCompiled.params,
          );
          return result.length;
        });

      // transaction() is only meaningful on the root adapter, but every
      // DBAdapter must provide one. For nested callers we surface an
      // Effect-backed no-op that just runs the callback against the
      // current (already-transactional) adapter so SAVEPOINT-style nesting
      // is at least well-defined as a flat call.
      const doTransaction = <R, E>(
        callback: (trx: DBTransactionAdapter) => Effect.Effect<R, E>,
      ): Effect.Effect<R, E | Error> => {
        // If this adapter is the root, use sql.begin to open a real tx.
        if (client === rootSql) {
          return Effect.async<R, E | Error>((resume) => {
            rootSql
              .begin(async (tx) => {
                const txAdapter = buildAdapter(tx);
                const exit = await Effect.runPromiseExit(callback(txAdapter));
                if (exit._tag === "Success") return exit.value;
                // Throw so postgres.js rolls back; we surface the original
                // failure cause via the outer resume.
                throw exit.cause;
              })
              .then((value) => resume(Effect.succeed(value as R)))
              .catch((err) => {
                // `err` may be the effect Cause we threw above, or a
                // postgres error. Narrow without losing the original.
                if (
                  err &&
                  typeof err === "object" &&
                  "_tag" in (err as object)
                ) {
                  resume(Effect.failCause(err as never));
                } else {
                  resume(
                    Effect.fail(wrapErr("transaction")(err)) as unknown as
                      Effect.Effect<never, E | Error>,
                  );
                }
              });
          });
        }
        // Nested / already-transactional: just run the callback against
        // the current tx adapter. postgres.js supports savepoints via
        // `tx.savepoint()` but we don't need that nesting today.
        return callback(buildAdapter(client) as DBTransactionAdapter);
      };

      return {
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
        transaction: doTransaction,
      };
    };

    return buildAdapter(rootSql);
  });
