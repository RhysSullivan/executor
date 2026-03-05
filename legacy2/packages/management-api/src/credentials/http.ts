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

const requireReadCredentials = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "credentials:read",
    workspaceId,
  });

const requireWriteCredentials = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "credentials:write",
    workspaceId,
  });

export const ControlPlaneCredentialsLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "credentials",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadCredentials(path.workspaceId))(
            service.listCredentialBindings(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("credentials.list", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("credentials.list", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("credentials.list", cause),
          ),
        ),
      )
      .handle("upsert", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteCredentials(path.workspaceId))(
            service.upsertCredentialBinding({
              workspaceId: path.workspaceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("credentials.upsert", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("credentials.upsert", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("credentials.upsert", cause),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteCredentials(path.workspaceId))(
            service.removeCredentialBinding({
              workspaceId: path.workspaceId,
              credentialBindingId: path.credentialBindingId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("credentials.remove", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("credentials.remove", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("credentials.remove", cause),
          ),
        ),
      ),
);
