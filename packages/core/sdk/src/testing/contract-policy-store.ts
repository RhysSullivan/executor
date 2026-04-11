import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { PolicyId, ScopeId } from "../ids";
import { Policy } from "../policies";
import type { PolicyStore } from "../stores/policy-store";

export interface PolicyStoreContractConfig {
  readonly makeStore: () => Effect.Effect<{
    readonly store: PolicyStore;
    readonly teardown: Effect.Effect<void>;
  }>;
}

const makePolicy = (id: string, scopeId: string): Policy =>
  new Policy({
    id: PolicyId.make(id),
    scopeId: ScopeId.make(scopeId),
    name: `policy-${id}`,
    action: "allow" as const,
    match: { toolPattern: undefined, sourceId: undefined },
    priority: 0,
    createdAt: new Date("2024-01-01"),
  });

export const createPolicyStoreContract = (
  name: string,
  config: PolicyStoreContractConfig,
): void => {
  describe(`${name} PolicyStore contract`, () => {
    it.effect("create then findByScope returns the policy", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          const policy = makePolicy("p1", "scope-1");
          yield* store.create(policy);
          const found = yield* store.findByScope(ScopeId.make("scope-1"));
          expect(found.length).toBe(1);
          expect(found[0]?.id as string).toBe("p1");
          expect(found[0]?.name).toBe("policy-p1");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("findByScope isolates by scope", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.create(makePolicy("p2a", "scope-a"));
          yield* store.create(makePolicy("p2b", "scope-b"));
          const scopeA = yield* store.findByScope(ScopeId.make("scope-a"));
          expect(scopeA.length).toBe(1);
          expect(scopeA[0]?.id as string).toBe("p2a");
          const scopeB = yield* store.findByScope(ScopeId.make("scope-b"));
          expect(scopeB.length).toBe(1);
          expect(scopeB[0]?.id as string).toBe("p2b");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("deleteById removes and returns true; missing returns false", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.create(makePolicy("p3", "scope-1"));
          const deleted = yield* store.deleteById(PolicyId.make("p3"), ScopeId.make("scope-1"));
          expect(deleted).toBe(true);
          const remaining = yield* store.findByScope(ScopeId.make("scope-1"));
          expect(remaining.length).toBe(0);
          const deletedAgain = yield* store.deleteById(
            PolicyId.make("p3"),
            ScopeId.make("scope-1"),
          );
          expect(deletedAgain).toBe(false);
        } finally {
          yield* teardown;
        }
      }),
    );
  });
};
