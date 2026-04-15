// ---------------------------------------------------------------------------
// @executor/storage-memory
//
// In-memory DBAdapter implementation. Used for tests, CLI tools,
// prototypes, and anywhere persistence isn't required. No external deps
// beyond `effect`. ~150 LOC of plain TypeScript.
//
// Transactions use snapshot-based rollback: the entire store is deep-
// copied on transaction entry, and restored from the snapshot if the
// effect fails. Correct for in-memory semantics; cheap because total
// data is small.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { DBAdapter, Where } from "@executor/storage-core";

// ---------------------------------------------------------------------------
// Where-clause evaluator — runs a Where[] against a plain row.
// Supports all operators declared in the storage-core Where type.
// ---------------------------------------------------------------------------

const matchRow = (
  row: Record<string, unknown>,
  where: readonly Where[] | undefined,
): boolean => {
  if (!where || where.length === 0) return true;

  const evalClause = (clause: Where): boolean => {
    const fieldValue = row[clause.field];
    const clauseValue = clause.value;

    const normalize = (v: unknown): unknown => {
      if (clause.mode === "insensitive" && typeof v === "string") {
        return v.toLowerCase();
      }
      return v;
    };

    const a = normalize(fieldValue);
    const b = normalize(clauseValue);
    const op = clause.operator ?? "eq";

    switch (op) {
      case "eq":
        return a === b;
      case "ne":
        return a !== b;
      case "lt":
        return (a as never) < (b as never);
      case "lte":
        return (a as never) <= (b as never);
      case "gt":
        return (a as never) > (b as never);
      case "gte":
        return (a as never) >= (b as never);
      case "in":
        return (
          Array.isArray(clauseValue) &&
          clauseValue.some((v) => normalize(v) === a)
        );
      case "not_in":
        return (
          Array.isArray(clauseValue) &&
          !clauseValue.some((v) => normalize(v) === a)
        );
      case "contains":
        return (
          typeof a === "string" && typeof b === "string" && a.includes(b)
        );
      case "starts_with":
        return (
          typeof a === "string" && typeof b === "string" && a.startsWith(b)
        );
      case "ends_with":
        return (
          typeof a === "string" && typeof b === "string" && a.endsWith(b)
        );
      default:
        return false;
    }
  };

  let result = evalClause(where[0]!);
  for (let i = 1; i < where.length; i++) {
    const clause = where[i]!;
    const next = evalClause(clause);
    result = clause.connector === "OR" ? result || next : result && next;
  }
  return result;
};

// ---------------------------------------------------------------------------
// Id generation — use crypto.randomUUID where available, fall back to
// a short random string. Only used when `create` is called without an
// explicit id and `forceAllowId` is false.
// ---------------------------------------------------------------------------

const generateId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// makeInMemoryAdapter — the whole thing.
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>;

const cloneStore = (source: Store): Store => {
  const copy: Store = new Map();
  for (const [model, rows] of source.entries()) {
    const inner = new Map<string, Record<string, unknown>>();
    for (const [id, row] of rows.entries()) {
      inner.set(id, { ...row });
    }
    copy.set(model, inner);
  }
  return copy;
};

export interface MakeInMemoryAdapterOptions {
  readonly adapterId?: string;
  readonly generateId?: () => string;
}

export const makeInMemoryAdapter = (
  options?: MakeInMemoryAdapterOptions,
): DBAdapter => {
  let store: Store = new Map();
  const idGen = options?.generateId ?? generateId;
  const id = options?.adapterId ?? "memory";

  const getModel = (model: string) => {
    let bucket = store.get(model);
    if (!bucket) {
      bucket = new Map();
      store.set(model, bucket);
    }
    return bucket;
  };

  const self: DBAdapter = {
    id,

    create: <T extends Record<string, unknown>, R = T>(data: {
      model: string;
      data: Omit<T, "id">;
      select?: string[] | undefined;
      forceAllowId?: boolean | undefined;
    }) =>
      Effect.sync(() => {
        const row = { ...data.data } as Record<string, unknown>;
        if (!("id" in row)) {
          row.id = idGen();
        }
        getModel(data.model).set(row.id as string, row);
        return row as unknown as R;
      }),

    createMany: <T extends Record<string, unknown>, R = T>(data: {
      model: string;
      data: ReadonlyArray<Omit<T, "id">>;
      forceAllowId?: boolean | undefined;
    }) =>
      Effect.sync(() => {
        const bucket = getModel(data.model);
        const out: Record<string, unknown>[] = [];
        for (const input of data.data) {
          const row = { ...input } as Record<string, unknown>;
          if (!("id" in row)) {
            row.id = idGen();
          }
          bucket.set(row.id as string, row);
          out.push(row);
        }
        return out as unknown as R[];
      }),

    findOne: <T>(data: {
      model: string;
      where: Where[];
      select?: string[] | undefined;
    }) =>
      Effect.sync(() => {
        for (const row of getModel(data.model).values()) {
          if (matchRow(row, data.where)) return row as unknown as T;
        }
        return null;
      }),

    findMany: <T>(data: {
      model: string;
      where?: Where[] | undefined;
      limit?: number | undefined;
      select?: string[] | undefined;
      sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
      offset?: number | undefined;
    }) =>
      Effect.sync(() => {
        let rows = Array.from(getModel(data.model).values()).filter((r) =>
          matchRow(r, data.where),
        );
        if (data.sortBy) {
          const { field, direction } = data.sortBy;
          const sign = direction === "asc" ? 1 : -1;
          rows = rows.slice().sort((x, y) => {
            const xv = x[field];
            const yv = y[field];
            if (xv === yv) return 0;
            return (xv as never) < (yv as never) ? -sign : sign;
          });
        }
        if (data.offset) rows = rows.slice(data.offset);
        if (data.limit !== undefined) rows = rows.slice(0, data.limit);
        return rows as unknown as T[];
      }),

    count: (data: { model: string; where?: Where[] | undefined }) =>
      Effect.sync(() => {
        let n = 0;
        for (const row of getModel(data.model).values()) {
          if (matchRow(row, data.where)) n++;
        }
        return n;
      }),

    update: <T>(data: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }) =>
      Effect.sync(() => {
        for (const row of getModel(data.model).values()) {
          if (matchRow(row, data.where)) {
            Object.assign(row, data.update);
            return row as unknown as T;
          }
        }
        return null;
      }),

    updateMany: (data: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }) =>
      Effect.sync(() => {
        let n = 0;
        for (const row of getModel(data.model).values()) {
          if (matchRow(row, data.where)) {
            Object.assign(row, data.update);
            n++;
          }
        }
        return n;
      }),

    delete: (data: { model: string; where: Where[] }) =>
      Effect.sync(() => {
        const bucket = getModel(data.model);
        for (const [rowId, row] of bucket.entries()) {
          if (matchRow(row, data.where)) {
            bucket.delete(rowId);
            return;
          }
        }
      }),

    deleteMany: (data: { model: string; where: Where[] }) =>
      Effect.sync(() => {
        const bucket = getModel(data.model);
        let n = 0;
        for (const [rowId, row] of bucket.entries()) {
          if (matchRow(row, data.where)) {
            bucket.delete(rowId);
            n++;
          }
        }
        return n;
      }),

    // Snapshot-based transactions. Deep-copy the store on entry, run
    // the callback, commit on success or restore from snapshot on
    // failure. Nested transactions compose — a failure inside a
    // nested transaction restores to its own snapshot, which may
    // itself be inside a larger transaction's snapshot.
    transaction: <R, E>(
      callback: (trx: Omit<DBAdapter, "transaction">) => Effect.Effect<R, E>,
    ) =>
      Effect.gen(function* () {
        const snapshot = cloneStore(store);
        const result = yield* callback(self).pipe(
          Effect.catchAll((e) => {
            store = snapshot;
            return Effect.fail(e);
          }),
        );
        return result;
      }),
  };

  return self;
};
