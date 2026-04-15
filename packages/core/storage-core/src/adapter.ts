// Vendored from better-auth (@better-auth/core/db/adapter) under MIT.
// See LICENSE.md. Adapted for executor: the BetterAuthOptions generic is
// removed and every operation returns Effect instead of Promise, since the
// executor runtime is Effect end-to-end.

import type { Effect } from "effect";

import type { DBSchema } from "./schema";

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

export type DBAdapter = {
  id: string;

  create: <T extends Record<string, unknown>, R = T>(data: {
    model: string;
    data: Omit<T, "id">;
    select?: string[] | undefined;
    /** Preserve an `id` in `data` instead of discarding it. */
    forceAllowId?: boolean | undefined;
  }) => Effect.Effect<R, Error>;

  /**
   * Insert multiple rows in one call. Backends that don't have native
   * bulk insert support fall back to sequential creates inside a single
   * transaction. Returns the inserted rows in input order.
   */
  createMany: <T extends Record<string, unknown>, R = T>(data: {
    model: string;
    data: ReadonlyArray<Omit<T, "id">>;
    forceAllowId?: boolean | undefined;
  }) => Effect.Effect<readonly R[], Error>;

  findOne: <T>(data: {
    model: string;
    where: Where[];
    select?: string[] | undefined;
    join?: JoinOption | undefined;
  }) => Effect.Effect<T | null, Error>;

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
  }) => Effect.Effect<T[], Error>;

  count: (data: {
    model: string;
    where?: Where[] | undefined;
  }) => Effect.Effect<number, Error>;

  /**
   * ⚠︎ `update` may return `null` if multiple rows match — prefer `updateMany`
   * when you don't need the returned row.
   */
  update: <T>(data: {
    model: string;
    where: Where[];
    update: Record<string, unknown>;
  }) => Effect.Effect<T | null, Error>;

  updateMany: (data: {
    model: string;
    where: Where[];
    update: Record<string, unknown>;
  }) => Effect.Effect<number, Error>;

  delete: (data: { model: string; where: Where[] }) => Effect.Effect<void, Error>;

  deleteMany: (data: { model: string; where: Where[] }) => Effect.Effect<number, Error>;

  /**
   * Run operations in a transaction. Backends without transaction support
   * must fall through and execute the callback sequentially.
   */
  transaction: <R, E>(
    callback: (trx: DBTransactionAdapter) => Effect.Effect<R, E>,
  ) => Effect.Effect<R, E | Error>;
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
  }) => Effect.Effect<T, Error>;

  update: <T>(data: {
    model: string;
    where: CleanedWhere[];
    update: T;
  }) => Effect.Effect<T | null, Error>;

  updateMany: (data: {
    model: string;
    where: CleanedWhere[];
    update: Record<string, unknown>;
  }) => Effect.Effect<number, Error>;

  findOne: <T>(data: {
    model: string;
    where: CleanedWhere[];
    select?: string[] | undefined;
    join?: JoinConfig | undefined;
  }) => Effect.Effect<T | null, Error>;

  findMany: <T>(data: {
    model: string;
    where?: CleanedWhere[] | undefined;
    limit: number;
    select?: string[] | undefined;
    sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
    offset?: number | undefined;
    join?: JoinConfig | undefined;
  }) => Effect.Effect<T[], Error>;

  delete: (data: {
    model: string;
    where: CleanedWhere[];
  }) => Effect.Effect<void, Error>;

  deleteMany: (data: {
    model: string;
    where: CleanedWhere[];
  }) => Effect.Effect<number, Error>;

  count: (data: {
    model: string;
    where?: CleanedWhere[] | undefined;
  }) => Effect.Effect<number, Error>;

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
          ) => Effect.Effect<R, E | Error>)
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
}

// Referenced by some adapter signatures.
export type { DBSchema };
