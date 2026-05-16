import { Effect } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import { isToolPolicyAction, type ToolPolicyRow } from "./core-schema";
import { byScopedId, makeCoreDb, scopedWhere } from "./executor-helpers";
import { StorageError, type StorageFailure } from "./fuma-runtime";
import {
  comparePolicyRow,
  isValidPattern,
  resolveToolPolicy,
  rowToToolPolicy,
  type CreateToolPolicyInput,
  type RemoveToolPolicyInput,
  type UpdateToolPolicyInput,
} from "./policies";

export const makePolicyFacade = (deps: {
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly scopeIds: readonly string[];
  readonly scopeRank: (row: { readonly scope_id: unknown }) => number;
  readonly assertScopeInStack: (
    label: string,
    scopeId: string,
  ) => Effect.Effect<void, StorageError>;
}) => {
  const loadAll = () => deps.core.findMany("tool_policy", { where: scopedWhere(deps.scopeIds) });

  const resolveForId = (toolId: string) =>
    Effect.gen(function* () {
      const policies = yield* loadAll();
      return resolveToolPolicy(toolId, policies, deps.scopeRank);
    });

  const list = () =>
    Effect.gen(function* () {
      const rows = yield* loadAll();
      const sorted = [...rows].sort((a, b) => {
        const sa = deps.scopeRank(a);
        const sb = deps.scopeRank(b);
        if (sa !== sb) return sa - sb;
        return comparePolicyRow(a, b);
      });
      return sorted.map((row) => rowToToolPolicy(row));
    }).pipe(Effect.withSpan("executor.policies.list"));

  const create = (input: CreateToolPolicyInput) =>
    Effect.gen(function* () {
      yield* deps.assertScopeInStack("tool policy targetScope", input.targetScope);
      if (!isValidPattern(input.pattern)) {
        return yield* new StorageError({
          message:
            `Invalid tool policy pattern "${input.pattern}". ` +
            `Patterns must be "*" (every tool), an exact tool id ("a.b.c"), ` +
            `or a trailing wildcard ("a.b.*"). Leading "*" prefixes ` +
            `("*foo", "*.foo") and "**" are not supported.`,
          cause: undefined,
        });
      }
      if (!isToolPolicyAction(input.action)) {
        return yield* new StorageError({
          message:
            `Invalid tool policy action "${String(input.action)}". ` +
            `Expected "approve" | "require_approval" | "block".`,
          cause: undefined,
        });
      }

      let position = input.position;
      if (position === undefined) {
        const existing = yield* deps.core.findMany("tool_policy", {
          where: (b) => b("scope_id", "=", input.targetScope),
        });
        let min: string | null = null;
        for (const row of existing) {
          const p = row.position;
          if (min === null || p < min) min = p;
        }
        position = generateKeyBetween(null, min);
      }

      const id = `pol_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
      const now = new Date();
      yield* deps.core.create("tool_policy", {
        id,
        scope_id: input.targetScope,
        pattern: input.pattern,
        action: input.action,
        position,
        created_at: now,
        updated_at: now,
      });
      return rowToToolPolicy({
        id,
        scope_id: input.targetScope,
        pattern: input.pattern,
        action: input.action,
        position,
        created_at: now,
        updated_at: now,
      } as ToolPolicyRow);
    }).pipe(Effect.withSpan("executor.policies.create"));

  const update = (input: UpdateToolPolicyInput) =>
    Effect.gen(function* () {
      yield* deps.assertScopeInStack("tool policy targetScope", input.targetScope);
      if (input.pattern !== undefined && !isValidPattern(input.pattern)) {
        return yield* new StorageError({
          message: `Invalid tool policy pattern "${input.pattern}".`,
          cause: undefined,
        });
      }
      if (input.action !== undefined && !isToolPolicyAction(input.action)) {
        return yield* new StorageError({
          message: `Invalid tool policy action "${String(input.action)}".`,
          cause: undefined,
        });
      }

      const rows = yield* deps.core.findMany("tool_policy", {
        where: byScopedId(input.targetScope, input.id),
      });
      const row = rows[0] ?? null;
      if (!row) {
        return yield* new StorageError({
          message: `Tool policy "${input.id}" not found in scope "${input.targetScope}".`,
          cause: undefined,
        });
      }

      const updated: ToolPolicyRow = {
        ...row,
        pattern: input.pattern ?? row.pattern,
        action: input.action ?? row.action,
        position: input.position ?? row.position,
        updated_at: new Date(),
      };
      yield* deps.core.updateMany("tool_policy", {
        where: byScopedId(input.targetScope, input.id),
        set: {
          pattern: updated.pattern,
          action: updated.action,
          position: updated.position,
          updated_at: updated.updated_at,
        },
      });
      return rowToToolPolicy(updated);
    }).pipe(Effect.withSpan("executor.policies.update"));

  const remove = (input: RemoveToolPolicyInput): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* deps.assertScopeInStack("tool policy targetScope", input.targetScope);
      yield* deps.core.deleteMany("tool_policy", {
        where: byScopedId(input.targetScope, input.id),
      });
    }).pipe(Effect.withSpan("executor.policies.remove"));

  const resolve = (toolId: string) =>
    resolveForId(toolId).pipe(Effect.withSpan("executor.policies.resolve"));

  return {
    create,
    list,
    loadAll,
    remove,
    resolve,
    resolveForId,
    update,
  };
};
