import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import {
  Actor,
  ActorForbiddenError,
  ActorUnauthenticatedError,
  any,
  requirePermission,
  type ActorShape,
  withPolicy,
} from "@executor-v2/domain";
import { type SourceStoreError } from "@executor-v2/persistence-ports";
import {
  type OrganizationId,
  type Workspace,
  type WorkspaceId,
} from "@executor-v2/schema";
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

const resolveActor = Effect.gen(function* () {
  const actorResolver = yield* ControlPlaneActorResolver;
  const request = yield* HttpServerRequest.HttpServerRequest;

  return yield* actorResolver.resolveActor({
    headers: request.headers,
  });
});

const requireReadWorkspaces = requirePermission({
  permission: "workspace:read",
});

const requireReadWorkspace = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "workspace:read",
    workspaceId,
  });

const requireReadWorkspaceInOrganization = (organizationId: OrganizationId) =>
  requirePermission({
    permission: "workspace:read",
    organizationId,
  });

const requireManageWorkspace = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "workspace:manage",
    workspaceId,
  });

const requireManageWorkspaceInOrganization = (organizationId: OrganizationId) =>
  requirePermission({
    permission: "workspace:manage",
    organizationId,
  });

const filterVisibleWorkspaces = (
  actor: ActorShape,
  workspaces: ReadonlyArray<Workspace>,
): Array<Workspace> =>
  workspaces.filter((workspace) =>
    actor.hasPermission({
      permission: "workspace:read",
      workspaceId: workspace.id,
    })
    || actor.hasPermission({
      permission: "workspace:read",
      organizationId: workspace.organizationId,
    })
  );

export const ControlPlaneWorkspacesLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "workspaces",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          const workspaces = yield* withPolicy(requireReadWorkspaces)(
            service.listWorkspaces(),
          ).pipe(Effect.provideService(Actor, actor));

          return filterVisibleWorkspaces(actor, workspaces);
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("workspaces.list", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("workspaces.list", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("workspaces.list", cause),
          ),
        ),
      )
      .handle("upsert", ({ payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          const workspacePolicy = payload.id
            ? any([
                requireManageWorkspace(payload.id),
                requireManageWorkspaceInOrganization(payload.organizationId),
              ])
            : requireManageWorkspaceInOrganization(payload.organizationId);

          return yield* withPolicy(workspacePolicy)(
            service.upsertWorkspace({ payload }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("workspaces.upsert", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("workspaces.upsert", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("workspaces.upsert", cause),
          ),
        ),
      ),
);
