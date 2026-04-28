// Scoped adapter — wraps a DBAdapter so every read on a tenant-scoped
// table filters by `scope_id IN (scopes)` and every write validates that
// its `scope_id` payload is one of the allowed scopes. Tables the
// schema doesn't declare a `scope_id` field on pass through untouched —
// the wrapper doesn't invent columns that aren't there.
//
// Writes are explicit: the caller must include `scope_id` in every
// create/update payload for scoped tables. The adapter does not pick a
// default. A missing `scope_id` on a scoped write, or a value outside
// the allowed `scopes` array, is a `StorageError`.
//
// The SDK's `createExecutor` wraps the root adapter (and every tx
// handle passed back into transaction callbacks) with this before
// handing it to the core table writers or to plugin storage via
// `typedAdapter(...)`. Plugins see a stable DBAdapter; they learn their
// scope from `ctx.scopes` and stamp it explicitly on every write.
//
// Contract: every multi-tenant table's schema must include
// `scope_id: { type: "string", required: true, index: true }`. Tables
// without it are shared across scopes by construction.

import { Effect } from "effect";

import {
  StorageError,
  type DBAdapter,
  type DBSchema,
  type DBTransactionAdapter,
  type Where,
} from "@executor/storage-core";

const SCOPE_FIELD = "scope_id";

export interface ScopeContext {
  /**
   * Precedence-ordered list of scope ids the wrapper accepts on reads
   * and writes. Innermost first. Reads walk every scope in the list
   * (via `scope_id IN (...)`); writes must name one of them explicitly
   * via `scope_id` in the payload.
   */
  readonly scopes: readonly string[];
}

const collectScopedModels = (schema: DBSchema): Set<string> => {
  const out = new Set<string>();
  for (const [model, def] of Object.entries(schema)) {
    if (def.fields[SCOPE_FIELD]) out.add(model);
  }
  return out;
};

const withScopeRead = (
  where: readonly Where[] | undefined,
  ctx: ScopeContext,
): Where[] => {
  const base = (where ?? []).filter((w) => w.field !== SCOPE_FIELD);
  const callerScope = (where ?? []).find((w) => w.field === SCOPE_FIELD);

  // Honor a caller-supplied scope filter IF it names a single scope
  // that lives in the executor's stack. This turns a stack-wide read
  // (default) into a single-scope read — and, for delete/update, pins
  // mutations to the named scope instead of letting the `IN (stack)`
  // injection silently widen them. An out-of-stack value is treated
  // as an isolation bypass attempt and discarded; the stack-wide
  // filter applies instead, so the caller sees nothing outside their
  // stack regardless of what they asked for.
  if (
    callerScope &&
    typeof callerScope.value === "string" &&
    ctx.scopes.includes(callerScope.value)
  ) {
    return [...base, { field: SCOPE_FIELD, value: callerScope.value }];
  }

  const scope: Where =
    ctx.scopes.length === 1
      ? { field: SCOPE_FIELD, value: ctx.scopes[0]! }
      : { field: SCOPE_FIELD, value: [...ctx.scopes], operator: "in" };
  return [...base, scope];
};

const assertScopedWrite = (
  model: string,
  data: Record<string, unknown>,
  ctx: ScopeContext,
): Effect.Effect<void, StorageError> => {
  const value = data[SCOPE_FIELD];
  if (typeof value !== "string" || value.length === 0) {
    return Effect.fail(
      new StorageError({
        message:
          `Write to scoped table "${model}" missing required \`scope_id\`. ` +
          `Callers must name the target scope explicitly.`,
        cause: undefined,
      }),
    );
  }
  if (!ctx.scopes.includes(value)) {
    return Effect.fail(
      new StorageError({
        message:
          `Write to scoped table "${model}" targets scope "${value}" ` +
          `which is not in the executor's scope stack ` +
          `[${ctx.scopes.join(", ")}].`,
        cause: undefined,
      }),
    );
  }
  return Effect.void;
};

type TxMethods = Omit<DBAdapter, "transaction" | "createSchema" | "options">;

const wrapTxMethods = (
  inner: TxMethods,
  ctx: ScopeContext,
  scopedModels: Set<string>,
): TxMethods => {
  const isScoped = (model: string) => scopedModels.has(model);

  return {
    id: inner.id,
    create: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            assertScopedWrite(
              data.model,
              data.data as Record<string, unknown>,
              ctx,
            ),
            () => inner.create(data),
          )
        : inner.create(data),
    createMany: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            Effect.all(
              data.data.map((row) =>
                assertScopedWrite(
                  data.model,
                  row as Record<string, unknown>,
                  ctx,
                ),
              ),
            ),
            () => inner.createMany(data),
          )
        : inner.createMany(data),
    findOne: (data) =>
      isScoped(data.model)
        ? inner.findOne({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.findOne(data),
    findMany: (data) =>
      isScoped(data.model)
        ? inner.findMany({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.findMany(data),
    count: (data) =>
      isScoped(data.model)
        ? inner.count({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.count(data),
    update: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            // If the caller sets `scope_id` in the update payload, it
            // must be one of the allowed scopes. If they don't, we leave
            // the row's existing scope_id in place — updates are scoped
            // by the where filter's IN clause, so you can only mutate
            // rows you can read. That's sufficient for isolation; we
            // don't need to force-stamp on update.
            (data.update as Record<string, unknown>)[SCOPE_FIELD] !== undefined
              ? assertScopedWrite(
                  data.model,
                  data.update as Record<string, unknown>,
                  ctx,
                )
              : Effect.void,
            () =>
              inner.update({
                ...data,
                where: withScopeRead(data.where, ctx),
              }),
          )
        : inner.update(data),
    updateMany: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            (data.update as Record<string, unknown>)[SCOPE_FIELD] !== undefined
              ? assertScopedWrite(
                  data.model,
                  data.update as Record<string, unknown>,
                  ctx,
                )
              : Effect.void,
            () =>
              inner.updateMany({
                ...data,
                where: withScopeRead(data.where, ctx),
              }),
          )
        : inner.updateMany(data),
    delete: (data) =>
      isScoped(data.model)
        ? inner.delete({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.delete(data),
    deleteMany: (data) =>
      isScoped(data.model)
        ? inner.deleteMany({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.deleteMany(data),
  };
};

export const scopeAdapter = (
  inner: DBAdapter,
  ctx: ScopeContext,
  schema: DBSchema,
): DBAdapter => {
  const scopedModels = collectScopedModels(schema);
  const tx = wrapTxMethods(inner, ctx, scopedModels);
  return {
    ...tx,
    transaction: (callback) =>
      inner.transaction((rawTrx) => {
        const scopedTrx: DBTransactionAdapter = wrapTxMethods(
          rawTrx,
          ctx,
          scopedModels,
        );
        return callback(scopedTrx);
      }),
    createSchema: inner.createSchema,
    options: inner.options,
  };
};

export const __scopeField = SCOPE_FIELD;
