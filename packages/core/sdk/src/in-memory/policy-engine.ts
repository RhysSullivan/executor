import { Effect } from "effect";

import { ScopeId, PolicyId } from "../ids";
import { PolicyNotFoundError } from "../errors";
import { evaluatePolicyDecision, sortPoliciesByPrecedence } from "../policy-eval";
import { Policy } from "../policies";
import type { CreatePolicyInput, PolicyCheckInput, UpdatePolicyPayload } from "../policies";

export const makeInMemoryPolicyEngine = () => {
  const policies = new Map<string, Policy>();
  let counter = 0;

  return {
    list: (scopeId: ScopeId) =>
      Effect.succeed(sortPoliciesByPrecedence([...policies.values()].filter((p) => p.scopeId === scopeId))),
    get: (policyId: PolicyId) =>
      Effect.fromNullable(policies.get(policyId)).pipe(
        Effect.mapError(() => new PolicyNotFoundError({ policyId })),
      ),
    check: (input: PolicyCheckInput) =>
      Effect.sync(() => evaluatePolicyDecision([...policies.values()], input)),
    add: (policy: CreatePolicyInput) =>
      Effect.sync(() => {
        const now = new Date();
        const id = PolicyId.make(`policy-${Date.now()}-${++counter}`);
        const full = new Policy({ ...policy, id, createdAt: now, updatedAt: now });
        policies.set(id, full);
        return full;
      }),
    update: (policyId: PolicyId, patch: UpdatePolicyPayload) =>
      Effect.gen(function* () {
        const existing = yield* Effect.fromNullable(policies.get(policyId)).pipe(
          Effect.mapError(() => new PolicyNotFoundError({ policyId })),
        );
        const next = new Policy({
          ...existing,
          ...Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          ),
          updatedAt: new Date(),
        });
        policies.set(policyId, next);
        return next;
      }),
    remove: (policyId: PolicyId) => Effect.succeed(policies.delete(policyId)),
  };
};
