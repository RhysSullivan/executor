// Vendored from better-auth (@better-auth/core/db/adapter) under MIT.
// See LICENSE.md. Adapted for executor: the BetterAuthOptions generic is
// removed and every operation returns Effect instead of Promise, since the
// executor runtime is Effect end-to-end.

import type { Effect } from "effect";

import type { StorageError, UniqueViolationError } from "./errors";
import type { DBFieldAttribute, DBSchema } from "./schema";

/** Error union every backend method may emit. */
export type StorageFailure = StorageError | UniqueViolationError;

// ---------------------------------------------------------------------------
// Where clauses
// ---------------------------------------------------------------------------

export const whereOperators = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
] as const;

export type WhereOperator = (typeof whereOperators)[number];

export type Where = {
  /** @default "eq" */
  operator?: WhereOperator | undefined;
  value: string | number | boolean | string[] | number[] | Date | null;
  field: string;
  /** @default "AND" */
  connector?: ("AND" | "OR") | undefined;
  /**
   * Case sensitivity for string comparisons. Applies to `eq`, `contains`,
   * `starts_with`, `ends_with` on string values.
   * @default "sensitive"
   */
  mode?: "sensitive" | "insensitive" | undefined;
};

/** A `Where` with every optional field filled in. */
export type CleanedWhere = Required<Where>;

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

/**
 * Per-query join options passed by the caller. Keys are model names; the
 * adapter resolves the on-columns via the schema's `references`.
 */
export type JoinOption = {
  [model: string]: boolean | { limit?: number };
};

/** Post-resolution shape seen by custom adapters. */
export type JoinConfig = {
  [model: string]: {
    on: {
      from: string;
      to: string;
    };
    /** @default 100 (ignored for unique relations, which force limit=1) */
    limit?: number;
    /** @default "one-to-many" */
    relation?: "one-to-one" | "one-to-many" | "many-to-many";
  };
};

// ---------------------------------------------------------------------------
// Adapter surface
// ---------------------------------------------------------------------------

export type DBTransactionAdapter = Omit<DBAdapter, "transaction">;

/**
 * Result of a `createSchema` call — a chunk of code plus a target path,
 * matching upstream better-auth. Plugin authors call this when they want
 * the adapter to generate SQL/migration source for a schema.
 */
export type DBAdapterSchemaCreation = {
  /** Source to write to the file. */
  code: string;
  /** Target path (relative to cwd of the developer's project). */
  path: string;
  /** Append to the file if it already exists. Ignored when `overwrite` is true. */
  append?: boolean | undefined;
  /** Overwrite the file if it already exists. */
  overwrite?: boolean | undefined;
};

export type DBAdapter = {
  id: string;

  create: <T extends Record<string, unknown>, R = T>(data: {
    model: string;
    data: Omit<T, "id">;
    select?: string[] | undefined;
    /** Preserve an `id` in `data` instead of discarding it. */
    forceAllowId?: boolean | undefined;
  }) => Effect.Effect<R, StorageFailure>;

  /**
   * Insert multiple rows in one call. Backends that don't have native
   * bulk insert support fall back to sequential creates inside a single
   * transaction. Returns the inserted rows in input order.
   */
  createMany: <T extends Record<string, unknown>, R = T>(data: {
    model: string;
    data: ReadonlyArray<Omit<T, "id">>;
    forceAllowId?: boolean | undefined;
  }) => Effect.Effect<readonly R[], StorageFailure>;

  findOne: <T>(data: {
    model: string;
    where: Where[];
    select?: string[] | undefined;
    join?: JoinOption | undefined;
  }) => Effect.Effect<T | null, StorageFailure>;

  findMany: <T>(data: {
    model: string;
    where?: Where[] | undefined;
    limit?: number | undefined;
    select?: string[] | undefined;
    sortBy?:
      | {
          field: string;
          direction: "asc" | "desc";
        }
      | undefined;
    offset?: number | undefined;
    join?: JoinOption | undefined;
  }) => Effect.Effect<readonly T[], StorageFailure>;

  count: (data: {
    model: string;
    where?: Where[] | undefined;
  }) => Effect.Effect<number, StorageFailure>;

  /**
   * ⚠︎ `update` may return `null` if multiple rows match — prefer `updateMany`
   * when you don't need the returned row.
   */
  update: <T>(data: {
    model: string;
    where: Where[];
    update: Record<string, unknown>;
  }) => Effect.Effect<T | null, StorageFailure>;

  updateMany: (data: {
    model: string;
    where: Where[];
    update: Record<string, unknown>;
  }) => Effect.Effect<number, StorageFailure>;

  delete: (data: { model: string; where: Where[] }) => Effect.Effect<void, StorageFailure>;

  deleteMany: (data: { model: string; where: Where[] }) => Effect.Effect<number, StorageFailure>;

  /**
   * Run operations in a transaction. Backends without transaction support
   * must fall through and execute the callback sequentially.
   */
  transaction: <R, E>(
    callback: (trx: DBTransactionAdapter) => Effect.Effect<R, E>,
  ) => Effect.Effect<R, E | StorageFailure>;

  /**
   * Optional migration-source generator. Forwarded verbatim from the
   * backend's `CustomAdapter.createSchema`. Plugin authors should guard
   * with `if (adapter.createSchema)` before calling.
   */
  createSchema?:
    | ((props: {
        file?: string | undefined;
        tables: DBSchema;
      }) => Effect.Effect<DBAdapterSchemaCreation, StorageFailure>)
    | undefined;

  /**
   * Runtime view of the factory config + the backend adapter's own options.
   * Upstream uses this so plugins can introspect capability flags (e.g.
   * "does my adapter support JSON?") without having to thread the config
   * manually. Populated by `createAdapter`.
   */
  options?:
    | ({ adapterConfig: DBAdapterFactoryConfig } & CustomAdapter["options"])
    | undefined;
};

// ---------------------------------------------------------------------------
// Custom adapter — the post-transform surface a backend implements. The
// factory (not yet vendored) wraps one of these into a full `DBAdapter` by
// applying schema-driven transforms, default values, id generation, and
// join resolution.
// ---------------------------------------------------------------------------

export interface CustomAdapter {
  create: <T extends Record<string, unknown>>(data: {
    model: string;
    data: T;
    select?: string[] | undefined;
  }) => Effect.Effect<T, StorageFailure>;

  /**
   * Native bulk insert. Required because over a real network (e.g.
   * Hyperdrive), per-row `create` inflates to N round-trips and can't
   * finish inside a request budget for specs with ~1000+ rows. SQL
   * backends issue a single multi-row INSERT; in-memory backends just
   * push the rows.
   */
  createMany: <T extends Record<string, unknown>>(data: {
    model: string;
    data: ReadonlyArray<T>;
  }) => Effect.Effect<T[], StorageFailure>;

  update: <T>(data: {
    model: string;
    where: CleanedWhere[];
    update: T;
  }) => Effect.Effect<T | null, StorageFailure>;

  updateMany: (data: {
    model: string;
    where: CleanedWhere[];
    update: Record<string, unknown>;
  }) => Effect.Effect<number, StorageFailure>;

  findOne: <T>(data: {
    model: string;
    where: CleanedWhere[];
    select?: string[] | undefined;
    join?: JoinConfig | undefined;
  }) => Effect.Effect<T | null, StorageFailure>;

  findMany: <T>(data: {
    model: string;
    where?: CleanedWhere[] | undefined;
    limit?: number | undefined;
    select?: string[] | undefined;
    sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
    offset?: number | undefined;
    join?: JoinConfig | undefined;
  }) => Effect.Effect<T[], StorageFailure>;

  delete: (data: {
    model: string;
    where: CleanedWhere[];
  }) => Effect.Effect<void, StorageFailure>;

  deleteMany: (data: {
    model: string;
    where: CleanedWhere[];
  }) => Effect.Effect<number, StorageFailure>;

  count: (data: {
    model: string;
    where?: CleanedWhere[] | undefined;
  }) => Effect.Effect<number, StorageFailure>;

  /**
   * Optional migration-source generator — plugin authors use this to
   * produce DDL / SQL for the schema a plugin expects. The factory
   * forwards this call through to the wrapped `DBAdapter.createSchema`.
   */
  createSchema?:
    | ((props: {
        file?: string | undefined;
        tables: DBSchema;
      }) => Effect.Effect<DBAdapterSchemaCreation, StorageFailure>)
    | undefined;

  options?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Adapter factory config — the capability flags a concrete backend uses to
// tell the (eventually vendored) factory which translations to apply.
// ---------------------------------------------------------------------------

export type DBAdapterDebugLogOption =
  | boolean
  | {
      logCondition?: (() => boolean) | undefined;
      create?: boolean | undefined;
      update?: boolean | undefined;
      updateMany?: boolean | undefined;
      findOne?: boolean | undefined;
      findMany?: boolean | undefined;
      delete?: boolean | undefined;
      deleteMany?: boolean | undefined;
      count?: boolean | undefined;
    };

export interface DBAdapterFactoryConfig {
  /** Pluralize table names (`organization` → `organizations`). @default false */
  usePlural?: boolean | undefined;
  debugLogs?: DBAdapterDebugLogOption | undefined;
  /** Human-readable name shown in debug logs. @default adapterId */
  adapterName?: string | undefined;
  adapterId: string;
  /** @default true */
  supportsNumericIds?: boolean | undefined;
  /** @default false */
  supportsUUIDs?: boolean | undefined;
  /** If false, JSON fields are serialized to strings on write. @default false */
  supportsJSON?: boolean | undefined;
  /** If false, Date fields are serialized to strings on write. @default true */
  supportsDates?: boolean | undefined;
  /** If false, booleans are serialized to 0/1 on write. @default true */
  supportsBooleans?: boolean | undefined;
  /** If false, array fields are serialized to JSON strings on write. @default false */
  supportsArrays?: boolean | undefined;
  transaction?:
    | (
        | false
        | (<R, E>(
            callback: (trx: DBTransactionAdapter) => Effect.Effect<R, E>,
          ) => Effect.Effect<R, E | StorageFailure>)
      )
    | undefined;
  /** Skip id generation on `create`. @default false */
  disableIdGeneration?: boolean | undefined;
  /** Rename fields on write (e.g. `id` → `_id` for Mongo). */
  mapKeysTransformInput?: Record<string, string> | undefined;
  /** Rename fields on read. */
  mapKeysTransformOutput?: Record<string, string> | undefined;
  /** Override the default id generator (e.g. for backends that need their own scheme). */
  customIdGenerator?: ((props: { model: string }) => string) | undefined;
  /**
   * Per-field hook run inside the factory's write-path transform. Called
   * once per field after the built-in encode step; return value replaces
   * the field value. Effect-ified from upstream (which returns `any`);
   * wrap sync values in `Effect.succeed`.
   */
  customTransformInput?:
    | ((props: {
        data: unknown;
        fieldAttributes: DBFieldAttribute;
        field: string;
        action:
          | "create"
          | "update"
          | "findOne"
          | "findMany"
          | "updateMany"
          | "delete"
          | "deleteMany"
          | "count";
        model: string;
        schema: DBSchema;
      }) => Effect.Effect<unknown, StorageFailure>)
    | undefined;
  /**
   * Per-field hook run inside the factory's read-path transform. Called
   * once per returned field after the built-in decode step; return value
   * replaces the field value.
   */
  customTransformOutput?:
    | ((props: {
        data: unknown;
        fieldAttributes: DBFieldAttribute;
        field: string;
        select: readonly string[];
        model: string;
        schema: DBSchema;
      }) => Effect.Effect<unknown, StorageFailure>)
    | undefined;
  /** Escape hatch — skip write-path transform entirely. @default false */
  disableTransformInput?: boolean | undefined;
  /** Escape hatch — skip read-path transform entirely. @default false */
  disableTransformOutput?: boolean | undefined;
  /** Escape hatch — skip join-path transform entirely. @default false */
  disableTransformJoin?: boolean | undefined;
}

// Referenced by some adapter signatures.
export type { DBSchema };
