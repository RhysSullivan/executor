import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import {
  Actor,
  ActorForbiddenError,
  ActorUnauthenticatedError,
  requirePermission,
  withPolicy,
} from "@executor-v2/domain";
import { type SourceStoreError } from "@executor-v2/persistence-ports";
import { type WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import {
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";
import { ControlPlaneApi } from "../api";
import { ControlPlaneActorResolver } from "../auth/actor-resolver";
import { ControlPlaneService } from "../service";

const toStorageError = (
  operation: string,
  cause: SourceStoreError,
): ControlPlaneStorageError =>
  new ControlPlaneStorageError({
    operation,
    message: "Control plane operation failed",
    details: cause.details ?? cause.message,
  });

const toForbiddenError = (
  operation: string,
  cause: ActorForbiddenError,
): ControlPlaneForbiddenError =>
  new ControlPlaneForbiddenError({
    operation,
    message: "Access denied",
    details: `${cause.permission} on ${cause.scope}`,
  });

const toUnauthorizedError = (
  operation: string,
  cause: ActorUnauthenticatedError,
): ControlPlaneUnauthorizedError =>
  new ControlPlaneUnauthorizedError({
    operation,
    message: cause.message,
    details: "Authentication required",
  });

const resolveWorkspaceActor = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const actorResolver = yield* ControlPlaneActorResolver;
    const request = yield* HttpServerRequest.HttpServerRequest;

    return yield* actorResolver.resolveWorkspaceActor({
      workspaceId,
      headers: request.headers,
    });
  });

const requireReadTools = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "sources:read",
    workspaceId,
  });

export const ControlPlaneToolsLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "tools",
  (handlers) =>
    handlers
      .handle("listWorkspaceTools", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadTools(path.workspaceId))(
            service.listWorkspaceTools(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("tools.listWorkspace", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("tools.listWorkspace", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("tools.listWorkspace", cause),
          ),
        ),
      )
      .handle("listSourceTools", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadTools(path.workspaceId))(
            service.listSourceTools({
              workspaceId: path.workspaceId,
              sourceId: path.sourceId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("tools.listSource", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("tools.listSource", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("tools.listSource", cause),
          ),
        ),
      )
      .handle("getToolDetail", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadTools(path.workspaceId))(
            service.getToolDetail({
              workspaceId: path.workspaceId,
              sourceId: path.sourceId,
              operationHash: path.operationHash,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("tools.getDetail", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("tools.getDetail", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("tools.getDetail", cause),
          ),
        ),
      ),
);
