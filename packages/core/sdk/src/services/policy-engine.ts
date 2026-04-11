// ---------------------------------------------------------------------------
// makePolicyEngine — service factory for the PolicyEngine Context.Tag.
//
// Ports business logic from storage-stores/policy-engine.ts, replacing
// ExecutorStorage calls with typed PolicyStore methods.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { Context } from "effect";

import type { Scope } from "../scope";
import { PolicyId } from "../ids";
import { Policy, PolicyEngine } from "../policies";
import type { PolicyStore } from "../stores/policy-store";

export const makePolicyEngine = (
  store: PolicyStore,
  scope: Scope,
): Context.Tag.Service<typeof PolicyEngine> => {
  let counter = 0;

  return {
    list: (_scopeId) => store.findByScope(scope.id),

    // no-op: policy check is a stub, preserved from storage-stores version
    check: (_input) => Effect.void,

    add: (policy: Omit<Policy, "id" | "createdAt">) =>
      Effect.gen(function* () {
        counter += 1;
        const id = PolicyId.make(`policy-${Date.now()}-${counter}`);
        const createdAt = new Date();
        const fullPolicy = new Policy({ ...policy, id, createdAt, scopeId: scope.id });
        yield* store.create(fullPolicy);
        return fullPolicy;
      }),

    remove: (policyId) => store.deleteById(policyId, scope.id),
  };
};
