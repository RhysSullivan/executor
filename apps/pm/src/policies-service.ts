import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  makeControlPlanePoliciesService,
  type ControlPlanePoliciesServiceShape,
} from "@executor-v2/management-api";
import { type Policy } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";

type PolicyRows = Pick<SqlControlPlanePersistence["rows"], "policies">;

const sourceStoreError = createSqlSourceStoreErrorMapper("policies");

const sortPolicies = (policies: ReadonlyArray<Policy>): Array<Policy> =>
  [...policies].sort((left, right) => {
    const leftPattern = left.toolPathPattern.toLowerCase();
    const rightPattern = right.toolPathPattern.toLowerCase();
    if (leftPattern === rightPattern) {
      return right.updatedAt - left.updatedAt;
    }

    return leftPattern.localeCompare(rightPattern);
  });

export const createPmPoliciesService = (
  rows: PolicyRows,
): ControlPlanePoliciesServiceShape =>
  makeControlPlanePoliciesService({
    listPolicies: (workspaceId) =>
      Effect.gen(function* () {
        const policies = yield* rows.policies.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.list", error),
          ),
        );

        return sortPolicies(
          policies.filter((policy) => policy.workspaceId === workspaceId),
        );
      }),

    upsertPolicy: (input) =>
      Effect.gen(function* () {
        const policies = yield* rows.policies.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.upsert", error),
          ),
        );

        const now = Date.now();
        const requestedId = input.payload.id;

        const existingIndex = requestedId
          ? policies.findIndex(
              (policy) =>
                policy.workspaceId === input.workspaceId && policy.id === requestedId,
            )
          : -1;

        const existing = existingIndex >= 0 ? policies[existingIndex] : null;

        const nextPolicy: Policy = {
          id: existing?.id ?? (requestedId ?? (`pol_${crypto.randomUUID()}` as Policy["id"])),
          workspaceId: input.workspaceId,
          toolPathPattern: input.payload.toolPathPattern,
          decision: input.payload.decision,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        yield* rows.policies.upsert(nextPolicy).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.upsert_write", error),
          ),
        );

        return nextPolicy;
      }),

    removePolicy: (input) =>
      Effect.gen(function* () {
        const policies = yield* rows.policies.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.remove", error),
          ),
        );

        const existing = policies.find(
          (policy) => policy.workspaceId === input.workspaceId && policy.id === input.policyId,
        );

        if (!existing) {
          return {
            removed: false,
          };
        }

        const removed = yield* rows.policies.removeById(input.policyId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.remove_write", error),
          ),
        );

        return {
          removed,
        };
      }),
  });
