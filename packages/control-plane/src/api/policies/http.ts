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

const requireReadPolicies = (workspaceId: string) =>
  requirePermission({
    permission: "policies:read",
    workspaceId: workspaceId as never,
  });

const requireWritePolicies = (workspaceId: string) =>
  requirePermission({
    permission: "policies:write",
    workspaceId: workspaceId as never,
  });

export const ControlPlanePoliciesLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "policies",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadPolicies(path.workspaceId))(
            service.listPolicies(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("policies.list", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("policies.list", cause)),
          ),
        ),
      )
      .handle("create", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWritePolicies(path.workspaceId))(
            service.createPolicy({ workspaceId: path.workspaceId, payload }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("policies.create", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("policies.create", cause)),
          ),
        ),
      )
      .handle("get", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadPolicies(path.workspaceId))(
            service.getPolicy({
              workspaceId: path.workspaceId,
              policyId: path.policyId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("policies.get", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("policies.get", cause)),
          ),
        ),
      )
      .handle("update", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWritePolicies(path.workspaceId))(
            service.updatePolicy({
              workspaceId: path.workspaceId,
              policyId: path.policyId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("policies.update", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("policies.update", cause)),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWritePolicies(path.workspaceId))(
            service.removePolicy({
              workspaceId: path.workspaceId,
              policyId: path.policyId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            Effect.fail(toUnauthorizedError("policies.remove", cause)),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            Effect.fail(toForbiddenError("policies.remove", cause)),
          ),
        ),
      ),
);
