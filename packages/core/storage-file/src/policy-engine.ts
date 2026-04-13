// ---------------------------------------------------------------------------
// KV-backed PolicyEngine
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import {
  Policy,
  PolicyId,
  PolicyNotFoundError,
  ScopeId,
  evaluatePolicyDecision,
  sortPoliciesByPrecedence,
} from "@executor/sdk";
import type { CreatePolicyInput, ScopedKv, PolicyCheckInput, UpdatePolicyPayload } from "@executor/sdk";

// ---------------------------------------------------------------------------
// Serialization — leverage Policy Schema.Class directly
// ---------------------------------------------------------------------------

const PolicyJson = Schema.parseJson(Policy);
const encodePolicy = Schema.encodeSync(PolicyJson);
const decodePolicy = Schema.decodeUnknownSync(PolicyJson);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeKvPolicyEngine = (policiesKv: ScopedKv, metaKv: ScopedKv) => {
  const getCounter = (): Effect.Effect<number> =>
    Effect.gen(function* () {
      const raw = yield* metaKv.get("policy_counter");
      return raw ? parseInt(raw, 10) : 0;
    });

  const setCounter = (n: number): Effect.Effect<void> =>
    metaKv.set([{ key: "policy_counter", value: String(n) }]);

  return {
    list: (scopeId: ScopeId) =>
      Effect.gen(function* () {
        const entries = yield* policiesKv.list();
        return sortPoliciesByPrecedence(
          entries.map((e) => decodePolicy(e.value)).filter((p) => p.scopeId === scopeId),
        );
      }),

    get: (policyId: PolicyId) =>
      Effect.gen(function* () {
        const raw = yield* policiesKv.get(policyId);
        if (!raw) {
          return yield* Effect.fail(new PolicyNotFoundError({ policyId }));
        }
        return decodePolicy(raw);
      }),

    check: (input: PolicyCheckInput) =>
      Effect.gen(function* () {
        const policies = yield* policiesKv.list();
        return evaluatePolicyDecision(
          policies.map((entry) => decodePolicy(entry.value)),
          input,
        );
      }),

    add: (policy: CreatePolicyInput) =>
      Effect.gen(function* () {
        const counter = (yield* getCounter()) + 1;
        yield* setCounter(counter);
        const now = new Date();
        const id = PolicyId.make(`policy-${Date.now()}-${counter}`);
        const full = new Policy({ ...policy, id, createdAt: now, updatedAt: now });
        yield* policiesKv.set([{ key: id, value: encodePolicy(full) }]);
        return full;
      }),

    update: (policyId: PolicyId, patch: UpdatePolicyPayload) =>
      Effect.gen(function* () {
        const raw = yield* policiesKv.get(policyId);
        if (!raw) {
          return yield* Effect.fail(new PolicyNotFoundError({ policyId }));
        }
        const existing = decodePolicy(raw);
        const next = new Policy({
          ...existing,
          ...Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          ),
          updatedAt: new Date(),
        });
        yield* policiesKv.set([{ key: policyId, value: encodePolicy(next) }]);
        return next;
      }),

    remove: (policyId: PolicyId) =>
      Effect.gen(function* () {
        const raw = yield* policiesKv.get(policyId);
        if (!raw) return false;
        yield* policiesKv.delete([policyId]);
        return true;
      }),
  };
};
