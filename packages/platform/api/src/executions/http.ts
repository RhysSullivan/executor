import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";

import { ExecutorApi } from "../api";
import { resolveRequestedLocalWorkspace } from "../local-context";

export const ExecutorExecutionsLive = HttpApiBuilder.group(
  ExecutorApi,
  "executions",
  (handlers) =>
    handlers
      .handle("create", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("executions.create", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.executions.create(payload)),
        ),
      )
      .handle("get", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.get", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.executions.get(path.executionId)),
        ),
      )
      .handle("resume", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("executions.resume", path.workspaceId).pipe(
          Effect.flatMap((executor) =>
            executor.effect.executions.resume(path.executionId, payload)
          ),
        ),
      ),
);
