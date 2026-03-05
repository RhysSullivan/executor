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

const requireReadStorage = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "storage:read",
    workspaceId,
  });

const requireWriteStorage = (workspaceId: WorkspaceId) =>
  requirePermission({
    permission: "storage:write",
    workspaceId,
  });

export const ControlPlaneStorageLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "storage",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadStorage(path.workspaceId))(
            service.listStorageInstances(path.workspaceId),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.list", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.list", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.list", cause),
          ),
        ),
      )
      .handle("open", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteStorage(path.workspaceId))(
            service.openStorageInstance({
              workspaceId: path.workspaceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.open", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.open", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.open", cause),
          ),
        ),
      )
      .handle("close", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteStorage(path.workspaceId))(
            service.closeStorageInstance({
              workspaceId: path.workspaceId,
              storageInstanceId: path.storageInstanceId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.close", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.close", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.close", cause),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteStorage(path.workspaceId))(
            service.removeStorageInstance({
              workspaceId: path.workspaceId,
              storageInstanceId: path.storageInstanceId,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.remove", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.remove", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.remove", cause),
          ),
        ),
      )
      .handle("listDirectory", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadStorage(path.workspaceId))(
            service.listStorageDirectory({
              workspaceId: path.workspaceId,
              storageInstanceId: path.storageInstanceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.listDirectory", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.listDirectory", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.listDirectory", cause),
          ),
        ),
      )
      .handle("readFile", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadStorage(path.workspaceId))(
            service.readStorageFile({
              workspaceId: path.workspaceId,
              storageInstanceId: path.storageInstanceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.readFile", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.readFile", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.readFile", cause),
          ),
        ),
      )
      .handle("listKv", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireReadStorage(path.workspaceId))(
            service.listStorageKv({
              workspaceId: path.workspaceId,
              storageInstanceId: path.storageInstanceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.listKv", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.listKv", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.listKv", cause),
          ),
        ),
      )
      .handle("querySql", ({ path, payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveWorkspaceActor(path.workspaceId);

          return yield* withPolicy(requireWriteStorage(path.workspaceId))(
            service.queryStorageSql({
              workspaceId: path.workspaceId,
              storageInstanceId: path.storageInstanceId,
              payload,
            }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("storage.querySql", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("storage.querySql", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("storage.querySql", cause),
          ),
        ),
      ),
);
