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

const requireReadMemberships = (organizationId: string) =>
  requirePermission({
    permission: "memberships:read",
    organizationId: organizationId as never,
  });

const requireWriteMemberships = (organizationId: string) =>
  requirePermission({
    permission: "memberships:write",
    organizationId: organizationId as never,
  });

export const ControlPlaneMembershipsLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "memberships",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireReadMemberships(path.organizationId))(
            service.listMemberships(path.organizationId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("memberships.list", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("memberships.list", cause)),
          ),
        ),
      )
      .handle("create", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireWriteMemberships(path.organizationId))(
            service.createMembership({ organizationId: path.organizationId, payload }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("memberships.create", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("memberships.create", cause)),
          ),
        ),
      )
      .handle("update", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireWriteMemberships(path.organizationId))(
            service.updateMembership({
              organizationId: path.organizationId,
              accountId: path.accountId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("memberships.update", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("memberships.update", cause)),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireWriteMemberships(path.organizationId))(
            service.removeMembership({
              organizationId: path.organizationId,
              accountId: path.accountId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("memberships.remove", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("memberships.remove", cause)),
          ),
        ),
      ),
);
