// ---------------------------------------------------------------------------
// KV-backed PolicyEngine
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import { Policy, PolicyId, ScopeId } from "@executor/core";
import type { ScopedKv, PolicyCheckInput } from "@executor/core";

// ---------------------------------------------------------------------------
// Serialization — leverage Policy Schema.Class directly
// ---------------------------------------------------------------------------

const PolicyJson = Schema.parseJson(Policy);
const encodePolicy = Schema.encodeSync(PolicyJson);
const decodePolicy = Schema.decodeUnknownSync(PolicyJson);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeKvPolicyEngine = (
  policiesKv: ScopedKv,
  metaKv: ScopedKv,
) => {
  const getCounter = (): Effect.Effect<number> =>
    Effect.gen(function* () {
      const raw = yield* metaKv.get("policy_counter");
      return raw ? parseInt(raw, 10) : 0;
    });

  const setCounter = (n: number): Effect.Effect<void> =>
    metaKv.set("policy_counter", String(n));

  return {
    list: (scopeId: ScopeId) =>
      Effect.gen(function* () {
        const entries = yield* policiesKv.list();
        return entries
          .map((e) => decodePolicy(e.value))
          .filter((p) => p.scopeId === scopeId);
      }),

    check: (_input: PolicyCheckInput) =>
      Effect.void,

    add: (policy: Omit<Policy, "id" | "createdAt">) =>
      Effect.gen(function* () {
        const counter = (yield* getCounter()) + 1;
        yield* setCounter(counter);
        const id = PolicyId.make(`policy-${counter}`);
        const full = new Policy({ ...policy, id, createdAt: new Date() });
        yield* policiesKv.set(id, encodePolicy(full));
        return full;
      }),

    remove: (policyId: PolicyId) =>
      Effect.gen(function* () {
        const raw = yield* policiesKv.get(policyId);
        if (!raw) return false;
        yield* policiesKv.delete(policyId);
        return true;
      }),
  };
};
