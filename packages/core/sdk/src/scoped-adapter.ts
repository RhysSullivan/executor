// Scoped adapter — wraps a DBAdapter so every read on a tenant-scoped
// table filters by `scope_id IN (read scopes)` and every write stamps
// `scope_id = writeTarget` into the row payload. Tables the schema
// doesn't declare a `scope_id` field on pass through untouched — the
// wrapper doesn't invent columns that aren't there.
//
// The `scopes` argument is an ordered-list primitive even though the
// SDK today always passes a single-element read list. The shape lets us
// layer scopes later (org → workspace → user, innermost wins on
// shadowing) without changing the wrapper signature or any plugin code.
// `read` and `write` are independent: a caller can read across an
// entire stack while writes always land in exactly one scope.
//
// The SDK's `createExecutor` wraps the root adapter (and every tx handle
// passed back into transaction callbacks) with this before handing it to
// the core table writers or to plugin storage via `typedAdapter(...)`.
// Plugins see a stable DBAdapter; they don't know or care about scope.
//
// Contract: every multi-tenant table's schema must include
// `scope_id: { type: "string", required: true, index: true }`. Tables
// without it are shared across scopes by construction.

import type {
  DBAdapter,
  DBSchema,
  DBTransactionAdapter,
  Where,
} from "@executor/storage-core";

const SCOPE_FIELD = "scope_id";

export interface ScopeContext {
  /**
   * Precedence-ordered list of scope ids visible to reads. Innermost
   * first when layering is used. Today always one element.
   */
  readonly read: readonly string[];
  /** The single scope id written rows get stamped with. */
  readonly write: string;
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
  scopes: ScopeContext,
): Where[] => {
  // Strip any caller-provided scope filter so they can't override
  // isolation, then AND ours in. For a single-scope stack we use `eq`
  // so downstream query planners see a simple equality; for multiple
  // scopes we emit `in (...)`.
  const base = (where ?? []).filter((w) => w.field !== SCOPE_FIELD);
  const scope: Where =
    scopes.read.length === 1
      ? { field: SCOPE_FIELD, value: scopes.read[0]! }
      : { field: SCOPE_FIELD, value: [...scopes.read], operator: "in" };
  return [...base, scope];
};

const stampScope = (
  data: Record<string, unknown>,
  writeScope: string,
): Record<string, unknown> => ({
  ...data,
  [SCOPE_FIELD]: writeScope,
});

type TxMethods = Omit<DBAdapter, "transaction" | "createSchema" | "options">;

const wrapTxMethods = (
  inner: TxMethods,
  scopes: ScopeContext,
  scopedModels: Set<string>,
): TxMethods => {
  const isScoped = (model: string) => scopedModels.has(model);

  return {
    id: inner.id,
    create: (data) =>
      isScoped(data.model)
        ? inner.create({
            ...data,
            data: stampScope(data.data as Record<string, unknown>, scopes.write),
          })
        : inner.create(data),
    createMany: (data) =>
      isScoped(data.model)
        ? inner.createMany({
            ...data,
            data: data.data.map((row) =>
              stampScope(row as Record<string, unknown>, scopes.write),
            ) as typeof data.data,
          })
        : inner.createMany(data),
    findOne: (data) =>
      isScoped(data.model)
        ? inner.findOne({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.findOne(data),
    findMany: (data) =>
      isScoped(data.model)
        ? inner.findMany({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.findMany(data),
    count: (data) =>
      isScoped(data.model)
        ? inner.count({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.count(data),
    update: (data) =>
      isScoped(data.model)
        ? inner.update({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.update(data),
    updateMany: (data) =>
      isScoped(data.model)
        ? inner.updateMany({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.updateMany(data),
    delete: (data) =>
      isScoped(data.model)
        ? inner.delete({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.delete(data),
    deleteMany: (data) =>
      isScoped(data.model)
        ? inner.deleteMany({ ...data, where: withScopeRead(data.where, scopes) })
        : inner.deleteMany(data),
  };
};

export const scopeAdapter = (
  inner: DBAdapter,
  scopes: ScopeContext,
  schema: DBSchema,
): DBAdapter => {
  const scopedModels = collectScopedModels(schema);
  const tx = wrapTxMethods(inner, scopes, scopedModels);
  return {
    ...tx,
    transaction: (callback) =>
      inner.transaction((rawTrx) => {
        const scopedTrx: DBTransactionAdapter = wrapTxMethods(
          rawTrx,
          scopes,
          scopedModels,
        );
        return callback(scopedTrx);
      }),
    createSchema: inner.createSchema,
    options: inner.options,
  };
};

export const __scopeField = SCOPE_FIELD;
