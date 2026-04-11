// ---------------------------------------------------------------------------
// Storage-backed PolicyEngine
//
// Implements PolicyEngineService over the core `policies` model in a
// generic ExecutorStorage.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { ExecutorStorage } from "@executor/storage";

import type { Scope } from "../scope";
import { PolicyId, ScopeId } from "../ids";
import {
  Policy,
  type PolicyAction,
  type PolicyCheckInput,
} from "../policies";

type PolicyRow = {
  readonly id: string;
  readonly scopeId: string;
  readonly name: string;
  readonly action: string;
  readonly matchToolPattern?: string | null;
  readonly matchSourceId?: string | null;
  readonly priority: number;
  readonly createdAt: Date;
};

const rowToPolicy = (row: PolicyRow, scopeId: ScopeId): Policy =>
  new Policy({
    id: PolicyId.make(row.id),
    scopeId,
    name: row.name,
    action: row.action as PolicyAction,
    match: {
      toolPattern: row.matchToolPattern ?? undefined,
      sourceId: row.matchSourceId ?? undefined,
    },
    priority: row.priority,
    createdAt: row.createdAt,
  });

export const makeStoragePolicyEngine = (storage: ExecutorStorage, scope: Scope) => {
  const scopeIdString = scope.id as string;
  let counter = 0;

  return {
    list: (_scopeId: ScopeId) =>
      Effect.gen(function* () {
        const rows = yield* storage
          .findMany<PolicyRow>({
            model: "policies",
            where: [{ field: "scopeId", value: scopeIdString }],
            sortBy: { field: "priority", direction: "desc" },
          })
          .pipe(Effect.orDie);
        return rows.map((row) => rowToPolicy(row, scope.id));
      }),

    check: (_input: PolicyCheckInput) => Effect.void,

    add: (policy: Omit<Policy, "id" | "createdAt">) =>
      Effect.gen(function* () {
        counter += 1;
        const id = PolicyId.make(`policy-${Date.now()}-${counter}`);
        const createdAt = new Date();

        yield* storage
          .create<PolicyRow>({
            model: "policies",
            data: {
              id: id as string,
              scopeId: scopeIdString,
              name: policy.name,
              action: policy.action,
              matchToolPattern: policy.match.toolPattern ?? null,
              matchSourceId: policy.match.sourceId ?? null,
              priority: policy.priority,
              createdAt,
            },
          })
          .pipe(Effect.orDie);

        return new Policy({ ...policy, id, createdAt });
      }),

    remove: (policyId: PolicyId) =>
      storage
        .delete({
          model: "policies",
          where: [
            { field: "id", value: policyId as string },
            { field: "scopeId", value: scopeIdString },
          ],
        })
        .pipe(Effect.orDie),
  };
};
