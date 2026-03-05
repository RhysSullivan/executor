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

const requireReadOrganizations = requirePermission({
  permission: "organizations:read",
});

const requireManageOrganizations = (organizationId: string) =>
  requirePermission({
    permission: "organizations:manage",
    organizationId: organizationId as never,
  });

export const ControlPlaneOrganizationsLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "organizations",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireReadOrganizations)(
            service.listOrganizations({
              accountId: actor.principal.accountId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("organizations.list", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("organizations.list", cause)),
          ),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* service.createOrganization({
            payload,
            createdByAccountId: actor.principal.accountId,
          });
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("organizations.create", cause)),
          ),
        ),
      )
      .handle("get", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireReadOrganizations)(
            service.getOrganization({
              organizationId: path.organizationId,
              accountId: actor.principal.accountId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("organizations.get", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("organizations.get", cause)),
          ),
        ),
      )
      .handle("update", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireManageOrganizations(path.organizationId))(
            service.updateOrganization({
              organizationId: path.organizationId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("organizations.update", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("organizations.update", cause)),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          return yield* withPolicy(requireManageOrganizations(path.organizationId))(
            service.removeOrganization({ organizationId: path.organizationId }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("organizations.remove", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("organizations.remove", cause)),
          ),
        ),
      ),
);
