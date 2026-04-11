import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { PolicyNotFoundError } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

const trimPolicyPatch = (payload: {
  toolPattern?: string;
  effect?: "allow" | "deny";
  approvalMode?: "auto" | "required";
  priority?: number;
  enabled?: boolean;
}) => ({
  ...payload,
  ...(payload.toolPattern !== undefined ? { toolPattern: payload.toolPattern.trim() } : {}),
});

export const PoliciesHandlers = HttpApiBuilder.group(ExecutorApi, "policies", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        return yield* executor.policies.list();
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const trimmed = {
          ...payload,
          toolPattern: payload.toolPattern.trim(),
        };
        if (trimmed.toolPattern.length === 0) {
          return yield* Effect.fail({
            _tag: "InvalidPolicyPayloadError" as const,
            message: "toolPattern must be a non-empty string",
          });
        }
        return yield* executor.policies.add(trimmed);
      }),
    )
    .handle("get", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        return yield* executor.policies.get(path.policyId);
      }),
    )
    .handle("update", ({ path, payload }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const patch = trimPolicyPatch(payload);
        if (Object.values(patch).every((value) => value === undefined)) {
          return yield* Effect.fail({
            _tag: "InvalidPolicyPayloadError" as const,
            message: "update payload must include at least one field",
          });
        }
        if (patch.toolPattern !== undefined && patch.toolPattern.length === 0) {
          return yield* Effect.fail({
            _tag: "InvalidPolicyPayloadError" as const,
            message: "toolPattern must be a non-empty string",
          });
        }
        return yield* executor.policies.update(path.policyId, patch);
      }),
    )
    .handle("remove", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const removed = yield* executor.policies.remove(path.policyId);
        if (!removed) {
          return yield* new PolicyNotFoundError({ policyId: path.policyId });
        }
        return { removed };
      }),
    ),
);
