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

const requireReadInteractions = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "interactions:read",
    workspaceId,
  });

const requireResolveInteractions = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "interactions:resolve",
    workspaceId,
  });

export const ControlPlaneInteractionsLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "interactions",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadInteractions(path.workspaceId))(
            service.listInteractions(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("interactions.list", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("interactions.list", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("interactions.list", cause),
          ),
        ),
      )
      .handle("list-run", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadInteractions(path.workspaceId))(
            service.listRunInteractions({
              workspaceId: path.workspaceId,
              runId: path.runId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("interactions.list_run", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("interactions.list_run", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("interactions.list_run", cause),
          ),
        ),
      )
      .handle("get", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadInteractions(path.workspaceId))(
            service.getInteraction({
              workspaceId: path.workspaceId,
              interactionId: path.interactionId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("interactions.get", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("interactions.get", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("interactions.get", cause),
          ),
        ),
      )
      .handle("resolve", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireResolveInteractions(path.workspaceId))(
            service.resolveInteraction({
              workspaceId: path.workspaceId,
              interactionId: path.interactionId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("interactions.resolve", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("interactions.resolve", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("interactions.resolve", cause),
          ),
        ),
      ),
);
