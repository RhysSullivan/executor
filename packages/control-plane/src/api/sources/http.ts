import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import * as Effect from "effect/Effect";

import {
  Actor,
  ActorForbiddenError,
  ActorUnauthenticatedError,
  requirePermission,
  withPolicy,
} from "#domain";

import { ControlPlaneApi } from "../api";
import { ControlPlaneActorResolver } from "../auth/actor-resolver";
import {
  ControlPlaneForbiddenError,
  ControlPlaneUnauthorizedError,
} from "../errors";
import { ControlPlaneService } from "../service";

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

const resolveWorkspaceActor = (workspaceId: string) =>
  Effect.gen(function* () {
    const actorResolver = yield* ControlPlaneActorResolver;
    const request = yield* HttpServerRequest.HttpServerRequest;

    return yield* actorResolver.resolveWorkspaceActor({
      workspaceId: workspaceId as never,
      headers: request.headers,
    });
  });

const requireReadSources = (workspaceId: string) =>
  requirePermission({
    permission: "sources:read",
    workspaceId: workspaceId as never,
  });

const requireWriteSources = (workspaceId: string) =>
  requirePermission({
    permission: "sources:write",
    workspaceId: workspaceId as never,
  });

export const ControlPlaneSourcesLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "sources",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadSources(path.workspaceId))(
            service.listSources(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("sources.list", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("sources.list", cause)),
          ),
        ),
      )
      .handle("create", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteSources(path.workspaceId))(
            service.createSource({ workspaceId: path.workspaceId, payload }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("sources.create", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("sources.create", cause)),
          ),
        ),
      )
      .handle("get", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadSources(path.workspaceId))(
            service.getSource({
              workspaceId: path.workspaceId,
              sourceId: path.sourceId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("sources.get", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("sources.get", cause)),
          ),
        ),
      )
      .handle("update", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteSources(path.workspaceId))(
            service.updateSource({
              workspaceId: path.workspaceId,
              sourceId: path.sourceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("sources.update", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("sources.update", cause)),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteSources(path.workspaceId))(
            service.removeSource({
              workspaceId: path.workspaceId,
              sourceId: path.sourceId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("sources.remove", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("sources.remove", cause)),
          ),
        ),
      ),
);
