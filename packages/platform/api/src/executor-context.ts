import type { ExecutorEffect } from "@executor/platform-sdk/effect";
import type { ScopeId as WorkspaceId } from "@executor/platform-sdk/schema";
import {
  ControlPlaneForbiddenError,
} from "@executor/platform-sdk/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ControlPlaneExecutor extends Context.Tag(
  "@executor/platform-api/ControlPlaneExecutor",
)<ControlPlaneExecutor, ExecutorEffect>() {}

export const createControlPlaneExecutorLayer = (executor: ExecutorEffect) =>
  Layer.succeed(ControlPlaneExecutor, executor);

export const getControlPlaneExecutor = () => ControlPlaneExecutor;

export const resolveRequestedLocalWorkspace = (
  operation: string,
  workspaceId: WorkspaceId,
) =>
  Effect.flatMap(ControlPlaneExecutor, (executor) =>
    executor.scopeId === workspaceId
      ? Effect.succeed(executor)
      : Effect.fail(
          new ControlPlaneForbiddenError({
            operation,
            message: "Requested workspace is not the active local workspace",
            details: `requestedWorkspaceId=${workspaceId} activeWorkspaceId=${executor.scopeId}`,
          }),
        ),
  );
