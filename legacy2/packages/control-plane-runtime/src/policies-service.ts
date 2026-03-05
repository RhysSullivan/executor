import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  makeControlPlanePoliciesService,
  type ControlPlanePoliciesServiceShape,
} from "@executor-v2/management-api";
import { type Policy } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

export const createRuntimeHostPoliciesService = (
  rows: PolicyRows,
): ControlPlanePoliciesServiceShape =>
  makeControlPlanePoliciesService({
    listPolicies: (workspaceId) =>
      Effect.gen(function* () {
        const policies = yield* rows.policies.listByWorkspaceId(workspaceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.list", error),
          ),
        );

        return sortPolicies(policies);
      }),

    upsertPolicy: (input) =>
      Effect.gen(function* () {
        const now = Date.now();
        const requestedId = input.payload.id;

        const existingOption = requestedId
          ? yield* rows.policies.getById(requestedId).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("policies.get_by_id", error),
            ),
          )
          : Option.none<Policy>();

        const existing = Option.getOrNull(existingOption);
        if (existing !== null && existing.workspaceId !== input.workspaceId) {
          return yield* sourceStoreError.fromMessage(
            "policies.upsert",
            "Policy belongs to another workspace",
            `workspace=${input.workspaceId} policy=${requestedId}`,
          );
        }

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
        const existingOption = yield* rows.policies.getById(input.policyId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("policies.get_by_id", error),
          ),
        );

        const existing = Option.getOrNull(existingOption);

        if (!existing || existing.workspaceId !== input.workspaceId) {
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
