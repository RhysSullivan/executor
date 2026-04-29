import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import type { ToolPolicy } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

const policyToResponse = (p: ToolPolicy) => ({
  id: p.id,
  scopeId: p.scopeId,
  pattern: p.pattern,
  action: p.action,
  position: p.position,
  createdAt: p.createdAt.getTime(),
  updatedAt: p.updatedAt.getTime(),
});

export const PoliciesHandlers = HttpApiBuilder.group(ExecutorApi, "policies", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const policies = yield* executor.policies.list();
          return policies.map(policyToResponse);
        }),
      ),
    )
    .handle("create", ({ path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const created = yield* executor.policies.create({
            scope: path.scopeId,
            pattern: payload.pattern,
            action: payload.action,
            position: payload.position,
          });
          return policyToResponse(created);
        }),
      ),
    )
    .handle("update", ({ path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const updated = yield* executor.policies.update({
            id: path.policyId,
            pattern: payload.pattern,
            action: payload.action,
            position: payload.position,
          });
          return policyToResponse(updated);
        }),
      ),
    )
    .handle("remove", ({ path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.policies.remove(path.policyId);
          return { removed: true };
        }),
      ),
    ),
);
