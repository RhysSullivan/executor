// ---------------------------------------------------------------------------
// drizzleAdapter — builds a DBAdapter from a drizzle db instance.
//
// Vendored from better-auth (packages/drizzle-adapter/src/drizzle-adapter.ts)
// under MIT. Adapted for executor:
//   - Promise/async → Effect.Effect<T, StorageFailure>
//   - Tables read from `db._.fullSchema` (drizzle schema introspection)
//   - Relational queries via `db.query[model]` for join resolution
//   - Filter/compile logic matches our CleanedWhere shape directly
//   - Piped through `createAdapter` so schema-driven transforms, id
//     generation, encode/decode all happen in storage-core
// ---------------------------------------------------------------------------

import { Effect, Schedule } from "effect";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type {
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBAdapterFactoryConfig,
  DBSchema,
  JoinConfig,
} from "@executor/storage-core";
import {
  StorageError,
  UniqueViolationError,
  createAdapter,
} from "@executor/storage-core";

// Mirrors `StorageFailure` from @executor/storage-core/adapter — kept
// local so we don't force a new named export on the public index. Both
// constructors are already exported, so the union is reconstructible.
type StorageFailure = StorageError | UniqueViolationError;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrizzleProvider = "sqlite" | "pg" | "mysql";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDB = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;

export interface DrizzleAdapterOptions {
  /**
   * A drizzle database instance constructed with `{ schema }` so that
   * `db._.fullSchema` and `db.query[model]` are populated. The adapter
   * reads table references from `db._.fullSchema` — no separate compile
   * step is needed.
   */
  readonly db: DrizzleDB;
  readonly schema: DBSchema;
  readonly provider: DrizzleProvider;
  readonly adapterId?: string;
  readonly supportsTransaction?: boolean;
  readonly customIdGenerator?: ((props: { model: string }) => string) | undefined;
}

// ---------------------------------------------------------------------------
// Insensitive helpers — better-auth ships these in a query-builders.ts
// helper. Inlined because our build is simpler.
// ---------------------------------------------------------------------------

const ilikeOrLike = (col: AnyTable, pattern: string, provider: DrizzleProvider) => {
  if (provider === "pg") {
    return sql`LOWER(${col}) LIKE LOWER(${pattern})`;
  }
  return sql`LOWER(${col}) LIKE LOWER(${pattern})`;
};

const insensitiveEq = (col: AnyTable, value: string) =>
  sql`LOWER(${col}) = LOWER(${value})`;

const insensitiveNe = (col: AnyTable, value: string) =>
  sql`LOWER(${col}) <> LOWER(${value})`;

// ---------------------------------------------------------------------------
// Where compiler — CleanedWhere[] → drizzle-orm SQL
//
// Ported from better-auth's drizzle adapter (convertWhereClause). For a
// mixed AND/OR list, clauses are bucketed by connector: AND (or missing)
// into one group, OR into another. The result is
//   (andClause₁ AND andClause₂ AND …) AND (orClause₁ OR orClause₂ OR …)
// i.e. the OR group is a single disjunction ANDed against the AND group.
// Matches upstream SQL convention; see conformance test "where: mixed
// AND/OR grouping follows upstream split-group semantics".
// ---------------------------------------------------------------------------

const buildCond = (
  table: AnyTable,
  w: CleanedWhere,
  provider: DrizzleProvider,
): SQL | undefined => {
  const col = table[w.field];
  if (!col) {
    throw new Error(
      `[storage-drizzle] unknown column "${w.field}" on drizzle table`,
    );
  }
  const mode = w.mode;
  const isInsensitive =
    mode === "insensitive" &&
    (typeof w.value === "string" ||
      (Array.isArray(w.value) &&
        (w.value as unknown[]).every((v) => typeof v === "string")));

  switch (w.operator) {
    case "in":
      if (!Array.isArray(w.value))
        throw new Error("Value must be an array for `in`");
      if (isInsensitive) {
        const values = w.value as readonly string[];
        if (values.length === 0) return sql`1 = 0`;
        const lowered = values.map((v) => v.toLowerCase());
        return sql`LOWER(${col}) IN ${lowered}`;
      }
      return inArray(col, w.value as unknown[]);
    case "not_in":
      if (!Array.isArray(w.value))
        throw new Error("Value must be an array for `not_in`");
      if (isInsensitive) {
        const values = w.value as readonly string[];
        if (values.length === 0) return sql`1 = 1`;
        const lowered = values.map((v) => v.toLowerCase());
        return sql`LOWER(${col}) NOT IN ${lowered}`;
      }
      return notInArray(col, w.value as unknown[]);
    case "contains":
      if (isInsensitive && typeof w.value === "string") {
        return ilikeOrLike(col, `%${w.value}%`, provider);
      }
      return like(col, `%${w.value}%`);
    case "starts_with":
      if (isInsensitive && typeof w.value === "string") {
        return ilikeOrLike(col, `${w.value}%`, provider);
      }
      return like(col, `${w.value}%`);
    case "ends_with":
      if (isInsensitive && typeof w.value === "string") {
        return ilikeOrLike(col, `%${w.value}`, provider);
      }
      return like(col, `%${w.value}`);
    case "lt":
      return lt(col, w.value);
    case "lte":
      return lte(col, w.value);
    case "gt":
      return gt(col, w.value);
    case "gte":
      return gte(col, w.value);
    case "ne":
      if (w.value === null) return isNotNull(col);
      if (isInsensitive && typeof w.value === "string") {
        return insensitiveNe(col, w.value);
      }
      return ne(col, w.value);
    case "eq":
    default:
      if (w.value === null) return isNull(col);
      if (isInsensitive && typeof w.value === "string") {
        return insensitiveEq(col, w.value);
      }
      return eq(col, w.value);
  }
};

const compileWhere = (
  table: AnyTable,
  where: readonly CleanedWhere[] | undefined,
  provider: DrizzleProvider,
): SQL | undefined => {
  if (!where || where.length === 0) return undefined;
  if (where.length === 1) {
    return buildCond(table, where[0]!, provider);
  }
  const andGroup = where.filter(
    (w) => w.connector === "AND" || !w.connector,
  );
  const orGroup = where.filter((w) => w.connector === "OR");
  const andClause =
    andGroup.length > 0
      ? and(...andGroup.map((w) => buildCond(table, w, provider)))
      : undefined;
  const orClause =
    orGroup.length > 0
      ? or(...orGroup.map((w) => buildCond(table, w, provider)))
      : undefined;
  if (andClause && orClause) return and(andClause, orClause);
  return andClause ?? orClause;
};

// ---------------------------------------------------------------------------
// Join → drizzle `with` clause
//
// Ported from upstream better-auth drizzle-adapter. Given a resolved
// `JoinConfig`, produce the `with: { … }` shape drizzle's query builder
// expects. The relation key matches the logical model name of the target.
// ---------------------------------------------------------------------------

const buildIncludes = (
  join: JoinConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const [model, attr] of Object.entries(join)) {
    const isUnique = attr.relation === "one-to-one";
    const limit = attr.limit ?? 100;
    out[model] = isUnique ? true : { limit };
  }
  return out;
};

// ---------------------------------------------------------------------------
// Promise → Effect helper
//
// Classifies postgres driver errors: `23505` (unique_violation) maps to
// `UniqueViolationError`, everything else to `StorageError`. Sqlite
// raises a `SQLITE_CONSTRAINT_UNIQUE` via a synchronous throw; we detect
// that via the message since better-sqlite3's error code is on the
// object too.
// ---------------------------------------------------------------------------

const isUniqueViolation = (cause: unknown): boolean => {
  if (!cause || typeof cause !== "object") return false;
  const c = cause as { code?: unknown; message?: unknown };
  if (c.code === "23505") return true;
  if (typeof c.code === "string" && c.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  if (
    typeof c.message === "string" &&
    /unique constraint|UNIQUE constraint failed/i.test(c.message)
  ) {
    return true;
  }
  return false;
};

// drizzle-orm wraps driver errors as `DrizzleQueryError` with a synthetic
// `"Failed query: <SQL>\nparams: <values>"` message and the real driver
// error on `.cause`. Walk down so classification + logging see the
// server-side code/message (`23505`, `value too long`, etc.) instead of
// the SQL+bound-values blob, which for OpenAPI specs is 1MB+ of spec text.
const unwrapDriverCause = (cause: unknown): unknown => {
  let cur = cause;
  for (let i = 0; i < 5; i++) {
    if (!cur || typeof cur !== "object") return cur;
    const c = cur as { cause?: unknown; code?: unknown; message?: unknown };
    if (typeof c.code === "string" && c.code.length > 0) return cur;
    if (c.cause && c.cause !== cur) {
      cur = c.cause;
      continue;
    }
    return cur;
  }
  return cur;
};

const classifyError = (
  op: string,
  model: string | undefined,
  cause: unknown,
): StorageFailure => {
  const driverCause = unwrapDriverCause(cause);
  if (isUniqueViolation(driverCause)) {
    return model !== undefined
      ? new UniqueViolationError({ model })
      : new UniqueViolationError({});
  }
  return new StorageError({
    message: `[storage-drizzle] ${op} failed: ${driverCause instanceof Error ? driverCause.message : String(driverCause)}`,
    cause: driverCause,
  });
};

// Hyperdrive (Cloudflare's Postgres pooler) periodically hands out a
// stale pooled connection that drops the write mid-query. Drizzle
// surfaces this as a driver error we classify into a StorageError whose
// message contains "Network connection lost" or "CONNECTION_CLOSED".
// Retrying on a fresh pooled connection almost always succeeds, so we
// retry transient errors twice with short exponential backoff. Unique
// violations and anything else fail fast.
export const isTransientStorageError = (err: StorageFailure): boolean => {
  if (err._tag !== "StorageError") return false;
  const msg = err.message;
  return (
    msg.includes("Network connection lost") ||
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("Connection terminated") ||
    msg.includes("ECONNRESET")
  );
};

const transientRetrySchedule = Schedule.exponential("50 millis");

const withTransientRetry = <T>(
  effect: Effect.Effect<T, StorageFailure>,
): Effect.Effect<T, StorageFailure> =>
  effect.pipe(
    Effect.retry({
      while: isTransientStorageError,
      times: 2,
      schedule: transientRetrySchedule,
    }),
  );

const runPromise = <T>(
  op: string,
  fn: () => Promise<T>,
  model?: string,
): Effect.Effect<T, StorageFailure> =>
  withTransientRetry(
    Effect.tryPromise({
      try: fn,
      catch: (cause) => classifyError(op, model, cause),
    }),
  );

// ---------------------------------------------------------------------------
// withReturning — mirrors better-auth's helper. sqlite + pg support
// `.returning()`; mysql needs a follow-up select (not implemented since
// we don't ship a mysql backend).
// ---------------------------------------------------------------------------

const withReturning = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  table: AnyTable,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  data: Record<string, unknown>,
  model: string,
): Effect.Effect<Record<string, unknown>, StorageFailure> =>
  Effect.gen(function* () {
    if (provider === "mysql") {
      yield* runPromise("mysql insert execute", () => builder.execute(), model);
      // best-effort: look up by id if present
      if (data.id !== undefined) {
        const rows = (yield* runPromise(
          "mysql select after insert",
          () => db.select().from(table).where(eq(table.id, data.id)).limit(1),
          model,
        )) as Record<string, unknown>[];
        if (!rows[0])
          return yield* Effect.fail(
            new StorageError({
              message: "[storage-drizzle] mysql insert: no row returned",
              cause: undefined,
            }),
          );
        return rows[0];
      }
      return yield* Effect.fail(
        new StorageError({
          message:
            "[storage-drizzle] mysql insert: id not provided, cannot recover row",
          cause: undefined,
        }),
      );
    }
    const rows = (yield* runPromise(
      "insert returning",
      () => builder.returning(),
      model,
    )) as Record<string, unknown>[];
    if (!rows[0])
      return yield* Effect.fail(
        new StorageError({
          message: "[storage-drizzle] insert returned no rows",
          cause: undefined,
        }),
      );
    return rows[0];
  });

// ---------------------------------------------------------------------------
// drizzleAdapter
// ---------------------------------------------------------------------------

export const drizzleAdapter = (options: DrizzleAdapterOptions): DBAdapter => {
  const { db, provider } = options;
  const fullSchema: Record<string, AnyTable> = db._.fullSchema ?? {};

  const getTable = (model: string): AnyTable => {
    const t = fullSchema[model];
    if (!t)
      throw new Error(
        `[storage-drizzle] unknown model "${model}" — not found in db._.fullSchema. ` +
          `Make sure the table is exported from the generated schema and passed to drizzle().`,
      );
    return t;
  };

  const backendAttrs = (model: string) => ({
    "executor.storage.backend": "drizzle" as const,
    "executor.storage.drizzle.provider": provider,
    "executor.storage.table": model,
  });

  const custom: CustomAdapter = {
    create: ({ model, data }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const builder = db.insert(table).values(data);
        const row = yield* withReturning(
          db,
          provider,
          table,
          builder,
          data,
          model,
        );
        return row as never;
      }).pipe(
        Effect.withSpan("executor.storage.backend.create", {
          attributes: backendAttrs(model),
        }),
      ),

    // Real multi-row INSERT in fixed-size chunks. One statement per
    // chunk, not one per row — per-row loops blow the Hyperdrive
    // request budget on specs with thousands of operations. Chunking
    // (vs a single giant statement) also keeps payload size bounded:
    // JSON columns like tool schemas / operation bindings can be a
    // few KB each, so a 2700-row insert becomes a >10MB statement
    // otherwise, which chokes both Hyperdrive ingress and WASM
    // Postgres (PGlite) in the test harness.
    createMany: ({ model, data }) =>
      Effect.gen(function* () {
        if (data.length === 0) return [] as never;
        const table = getTable(model);
        const CHUNK = 500;
        const all: Record<string, unknown>[] = [];
        for (let i = 0; i < data.length; i += CHUNK) {
          const slice = data.slice(i, i + CHUNK) as Record<string, unknown>[];
          const rows = (yield* runPromise(
            "insert many returning",
            () => db.insert(table).values(slice).returning(),
            model,
          )) as Record<string, unknown>[];
          for (const row of rows) all.push(row);
        }
        return all as never;
      }).pipe(
        Effect.withSpan("executor.storage.backend.create_many", {
          attributes: {
            ...backendAttrs(model),
            "executor.storage.row_count": data.length,
          },
        }),
      ),

    findOne: ({ model, where, join }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        if (join && db.query && db.query[model]) {
          const includes = buildIncludes(join);
          const rows = (yield* runPromise(
            "findOne query.findFirst",
            () =>
              Promise.resolve(
                db.query[model].findFirst({
                  where: clause,
                  with: includes,
                }),
              ),
            model,
          )) as Record<string, unknown> | undefined;
          return (rows ?? null) as never;
        }
        let q = db.select().from(table);
        if (clause) q = q.where(clause);
        const rows = (yield* runPromise(
          "findOne select",
          () => q.limit(1),
          model,
        )) as Record<string, unknown>[];
        return (rows[0] ?? null) as never;
      }).pipe(
        Effect.withSpan("executor.storage.backend.find_one", {
          attributes: backendAttrs(model),
        }),
      ),

    findMany: ({ model, where, limit, sortBy, offset, join }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        if (join && db.query && db.query[model]) {
          const includes = buildIncludes(join);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const opts: Record<string, any> = {
            where: clause,
            with: includes,
          };
          if (limit !== undefined) opts.limit = limit;
          if (offset !== undefined) opts.offset = offset;
          if (sortBy) {
            const col = table[sortBy.field];
            const fn = sortBy.direction === "desc" ? desc : asc;
            opts.orderBy = [fn(col)];
          }
          const rows = (yield* runPromise(
            "findMany query.findMany",
            () => Promise.resolve(db.query[model].findMany(opts)),
            model,
          )) as Record<string, unknown>[];
          return rows as never[];
        }
        let q = db.select().from(table);
        if (clause) q = q.where(clause);
        if (sortBy) {
          const col = table[sortBy.field];
          const fn = sortBy.direction === "desc" ? desc : asc;
          q = q.orderBy(fn(col));
        }
        // SQLite's SQL grammar requires LIMIT whenever OFFSET is present.
        // Emit a max-int ceiling for the offset-only case on sqlite; postgres
        // accepts offset-only natively.
        if (limit !== undefined) q = q.limit(limit);
        else if (offset !== undefined && provider === "sqlite")
          q = q.limit(Number.MAX_SAFE_INTEGER);
        if (offset !== undefined) q = q.offset(offset);
        const rows = (yield* runPromise(
          "findMany select",
          () => Promise.resolve(q),
          model,
        )) as Record<string, unknown>[];
        return rows as never[];
      }).pipe(
        Effect.withSpan("executor.storage.backend.find_many", {
          attributes: backendAttrs(model),
        }),
      ),

    count: ({ model, where }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        let q = db.select({ c: count() }).from(table);
        if (clause) q = q.where(clause);
        const rows = (yield* runPromise(
          "count select",
          () => Promise.resolve(q),
          model,
        )) as { c: number | string | bigint }[];
        const raw = rows[0]?.c ?? 0;
        return typeof raw === "number" ? raw : Number(raw);
      }).pipe(
        Effect.withSpan("executor.storage.backend.count", {
          attributes: backendAttrs(model),
        }),
      ),

    update: ({ model, where, update }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        // Find matching rows first — if >1, DBAdapter contract says null
        let findQ = db.select().from(table);
        if (clause) findQ = findQ.where(clause);
        const matched = (yield* runPromise(
          "update pre-select",
          () => findQ.limit(2),
          model,
        )) as Record<string, unknown>[];
        if (matched.length === 0) return null;
        if (matched.length > 1) return null;
        const target = matched[0]!;
        let updQ = db.update(table).set(update).where(eq(table.id, target.id));
        if (provider !== "mysql") {
          const rows = (yield* runPromise(
            "update returning",
            () => updQ.returning(),
            model,
          )) as Record<string, unknown>[];
          return (rows[0] ?? null) as never;
        }
        yield* runPromise(
          "mysql update execute",
          () => updQ.execute(),
          model,
        );
        const reread = (yield* runPromise(
          "mysql update reread",
          () => db.select().from(table).where(eq(table.id, target.id)).limit(1),
          model,
        )) as Record<string, unknown>[];
        return (reread[0] ?? null) as never;
      }).pipe(
        Effect.withSpan("executor.storage.backend.update", {
          attributes: backendAttrs(model),
        }),
      ),

    updateMany: ({ model, where, update }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        // Count first for the return value (sqlite's .run returns changes
        // but we don't want to rely on that in the generic path)
        let countQ = db.select({ c: count() }).from(table);
        if (clause) countQ = countQ.where(clause);
        const rows = (yield* runPromise(
          "updateMany count",
          () => Promise.resolve(countQ),
          model,
        )) as { c: number | string | bigint }[];
        const n = Number(rows[0]?.c ?? 0);
        if (n === 0) return 0;
        let updQ = db.update(table).set(update);
        if (clause) updQ = updQ.where(clause);
        yield* runPromise(
          "updateMany execute",
          () => Promise.resolve(updQ),
          model,
        );
        return n;
      }).pipe(
        Effect.withSpan("executor.storage.backend.update_many", {
          attributes: backendAttrs(model),
        }),
      ),

    delete: ({ model, where }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        // Mirror in-memory semantics: delete first matching row only
        let findQ = db.select({ id: table.id }).from(table);
        if (clause) findQ = findQ.where(clause);
        const matched = (yield* runPromise(
          "delete pre-select",
          () => findQ.limit(1),
          model,
        )) as { id: unknown }[];
        const first = matched[0];
        if (!first) return;
        yield* runPromise(
          "delete exec",
          () => Promise.resolve(db.delete(table).where(eq(table.id, first.id))),
          model,
        );
      }).pipe(
        Effect.withSpan("executor.storage.backend.delete", {
          attributes: backendAttrs(model),
        }),
      ),

    deleteMany: ({ model, where }) =>
      Effect.gen(function* () {
        const table = getTable(model);
        const clause = compileWhere(table, where, provider);
        let countQ = db.select({ c: count() }).from(table);
        if (clause) countQ = countQ.where(clause);
        const rows = (yield* runPromise(
          "deleteMany count",
          () => Promise.resolve(countQ),
          model,
        )) as { c: number | string | bigint }[];
        const n = Number(rows[0]?.c ?? 0);
        if (n === 0) return 0;
        let delQ = db.delete(table);
        if (clause) delQ = delQ.where(clause);
        yield* runPromise(
          "deleteMany exec",
          () => Promise.resolve(delQ),
          model,
        );
        return n;
      }).pipe(
        Effect.withSpan("executor.storage.backend.delete_many", {
          attributes: backendAttrs(model),
        }),
      ),
  };

  // Transaction strategy differs by dialect:
  //
  //   pg: use drizzle's `db.transaction(cb)`, which delegates to
  //       postgres.js's `sql.begin()`. postgres.js rejects a plain
  //       `sql.unsafe("BEGIN")` because its query protocol wraps every
  //       query in its own implicit autocommit — transaction control
  //       has to go through `sql.begin()`.
  //
  //   sqlite: emit raw BEGIN / COMMIT / ROLLBACK against `db.run(...)`.
  //       drizzle-sqlite's `.transaction(cb)` rejects async callbacks
  //       and we need async to bridge Effect.
  //
  //   mysql: same raw-statement path as sqlite, untested in-tree.
  const txFn: DBAdapterFactoryConfig["transaction"] = options.supportsTransaction
    ? <R, E>(
        cb: (trx: Parameters<DBAdapter["transaction"]>[0] extends (
          t: infer T,
        ) => unknown
          ? T
          : never) => Effect.Effect<R, E>,
      ) => {
        if (provider === "pg") {
          // Wrap drizzle's real transaction. The nested adapter runs
          // every query through the `tx` handle so all writes stay
          // inside the `sql.begin()` boundary. Throw from the inner
          // Promise on Effect failure — that's how drizzle knows to
          // issue ROLLBACK.
          type TxShape = Parameters<DBAdapter["transaction"]>[0] extends (t: infer T) => unknown
            ? T
            : never;
          class TxFailure {
            constructor(public readonly inner: E) {}
          }
          return Effect.tryPromise({
            try: () =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (db as any).transaction(async (tx: unknown) => {
                const nested = drizzleAdapter({
                  ...options,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  db: tx as any,
                  supportsTransaction: false,
                }) as TxShape;
                const exit = await Effect.runPromise(
                  Effect.either(cb(nested)) as Effect.Effect<
                    { readonly _tag: "Right"; readonly right: R } | { readonly _tag: "Left"; readonly left: E },
                    never
                  >,
                );
                if (exit._tag === "Left") throw new TxFailure(exit.left);
                return exit.right;
              }),
            catch: (e) => e,
          }).pipe(
            Effect.mapError((e) => {
              if (e instanceof TxFailure) return e.inner;
              return classifyError("pg transaction", undefined, e);
            }),
            Effect.withSpan("executor.storage.backend.transaction", {
              attributes: {
                "executor.storage.backend": "drizzle",
                "executor.storage.drizzle.provider": provider,
                "executor.storage.transaction.strategy": "drizzle_native",
              },
            }),
          ) as Effect.Effect<R, E | StorageFailure>;
        }

        return Effect.gen(function* () {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dbAny = db as any;
          const runner: ((s: unknown) => unknown) | undefined = dbAny.run
            ? dbAny.run.bind(dbAny)
            : dbAny.execute
              ? dbAny.execute.bind(dbAny)
              : undefined;
          const runStmt = (stmt: string) =>
            Effect.try({
              try: () => {
                if (!runner) {
                  throw new Error("drizzle db has neither run() nor execute()");
                }
                const res = runner(sql.raw(stmt));
                if (res && typeof (res as { then?: unknown }).then === "function") {
                  return res as Promise<unknown>;
                }
                return res;
              },
              catch: (cause) => classifyError(stmt, undefined, cause),
            });
          const maybePromise = yield* runStmt("BEGIN");
          if (maybePromise && typeof (maybePromise as { then?: unknown }).then === "function") {
            yield* Effect.tryPromise({
              try: () => maybePromise as Promise<unknown>,
              catch: (cause) => classifyError("BEGIN", undefined, cause),
            });
          }
          const nested = drizzleAdapter({
            ...options,
            supportsTransaction: false,
          }) as Parameters<DBAdapter["transaction"]>[0] extends (t: infer T) => unknown ? T : never;
          const result = yield* cb(nested).pipe(
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                yield* runStmt("ROLLBACK").pipe(Effect.orElse(() => Effect.void));
                return yield* Effect.fail(e);
              }),
            ),
          );
          const commitRes = yield* runStmt("COMMIT");
          if (commitRes && typeof (commitRes as { then?: unknown }).then === "function") {
            yield* Effect.tryPromise({
              try: () => commitRes as Promise<unknown>,
              catch: (cause) => classifyError("COMMIT", undefined, cause),
            });
          }
          return result;
        }).pipe(
          Effect.withSpan("executor.storage.backend.transaction", {
            attributes: {
              "executor.storage.backend": "drizzle",
              "executor.storage.drizzle.provider": provider,
              "executor.storage.transaction.strategy": "raw_begin_commit",
            },
          }),
        );
      }
    : undefined;

  return createAdapter({
    schema: options.schema,
    config: {
      adapterId: options.adapterId ?? "drizzle",
      // Dialect capability flags. We always set these to `true` because
      // drizzle-orm's typed columns (jsonb / timestamp / boolean / array)
      // handle serialization for us — the factory should pass JS-native
      // values straight through. The CLI-generated schema maps every
      // DBSchema type onto a typed drizzle column.
      supportsJSON: true,
      supportsArrays: true,
      supportsBooleans: true,
      supportsDates: true,
      supportsUUIDs: provider === "pg",
      customIdGenerator: options.customIdGenerator,
      transaction: txFn ?? false,
    },
    adapter: custom,
  });
};
