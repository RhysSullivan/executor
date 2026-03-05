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

const resolveActor = Effect.gen(function* () {
  const actorResolver = yield* ControlPlaneActorResolver;
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* actorResolver.resolveActor({ headers: request.headers });
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

const requireReadWorkspace = (workspaceId: string) =>
  requirePermission({
    permission: "workspace:read",
    workspaceId: workspaceId as never,
  });

const requireManageWorkspace = (workspaceId: string) =>
  requirePermission({
    permission: "workspace:manage",
    workspaceId: workspaceId as never,
  });

const requireOrganizationWorkspaceRead = (organizationId: string) =>
  requirePermission({
    permission: "workspace:read",
    organizationId: organizationId as never,
  });

const requireOrganizationWorkspaceManage = (organizationId: string) =>
  requirePermission({
    permission: "workspace:manage",
    organizationId: organizationId as never,
  });

export const ControlPlaneWorkspacesLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "workspaces",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(
            requireOrganizationWorkspaceRead(path.organizationId),
          )(service.listWorkspaces(path.organizationId)).pipe(
            Effect.provideService(Actor, actor),
          );
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("workspaces.list", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("workspaces.list", cause)),
          ),
        ),
      )
      .handle("create", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(
            requireOrganizationWorkspaceManage(path.organizationId),
          )(
            service.createWorkspace({
              organizationId: path.organizationId,
              payload,
              createdByAccountId: actor.principal.accountId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("workspaces.create", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("workspaces.create", cause)),
          ),
        ),
      )
      .handle("get", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadWorkspace(path.workspaceId))(
            service.getWorkspace(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("workspaces.get", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("workspaces.get", cause)),
          ),
        ),
      )
      .handle("update", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireManageWorkspace(path.workspaceId))(
            service.updateWorkspace({ workspaceId: path.workspaceId, payload }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("workspaces.update", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("workspaces.update", cause)),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireManageWorkspace(path.workspaceId))(
            service.removeWorkspace({ workspaceId: path.workspaceId }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("workspaces.remove", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("workspaces.remove", cause)),
          ),
        ),
      ),
);
