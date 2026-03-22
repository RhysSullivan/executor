import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";

import { ExecutorApi } from "../api";
import { resolveRequestedLocalWorkspace } from "../local-context";

export const ExecutorPoliciesLive = HttpApiBuilder.group(
  ExecutorApi,
  "policies",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        resolveRequestedLocalWorkspace("policies.list", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.policies.list()),
        ),
      )
      .handle("create", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "policies.create",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) => executor.effect.policies.create(payload)),
        ),
      )
      .handle("get", ({ path }) =>
        resolveRequestedLocalWorkspace("policies.get", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.policies.get(path.policyId)),
        ),
      )
      .handle("update", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "policies.update",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.policies.update(path.policyId, payload)
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "policies.remove",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) => executor.effect.policies.remove(path.policyId)),
          Effect.map((result) => ({
            removed: result.removed,
          })),
        ),
      ),
);
