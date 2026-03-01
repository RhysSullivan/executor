import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import {
  Actor,
  ActorForbiddenError,
  ActorUnauthenticatedError,
  requirePermission,
  type ActorShape,
  withPolicy,
} from "@executor-v2/domain";
import { type SourceStoreError } from "@executor-v2/persistence-ports";
import {
  type Organization,
  type OrganizationId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import {
  ControlPlaneBadRequestError,
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

const requireReadOrganizations = requirePermission({
  permission: "organizations:read",
});

const requireManageOrganization = (organizationId: OrganizationId) =>
  requirePermission({
    permission: "organizations:manage",
    organizationId,
  });

const filterVisibleOrganizations = (
  actor: ActorShape,
  organizations: ReadonlyArray<Organization>,
): Array<Organization> =>
  organizations.filter((organization) =>
    actor.hasPermission({
      permission: "organizations:read",
      organizationId: organization.id,
    })
  );

export const ControlPlaneOrganizationsLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "organizations",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          const organizations = yield* withPolicy(requireReadOrganizations)(
            service.listOrganizations(),
          ).pipe(Effect.provideService(Actor, actor));

          return filterVisibleOrganizations(actor, organizations);
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("organizations.list", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("organizations.list", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("organizations.list", cause),
          ),
        ),
      )
      .handle("upsert", ({ payload }) =>
        Effect.gen(function* () {
          const service = yield* ControlPlaneService;
          const actor = yield* resolveActor;

          if (!payload.id) {
            return yield* new ControlPlaneBadRequestError({
              operation: "organizations.upsert",
              message: "organization id is required",
              details: "payload.id must be provided for scoped authorization",
            });
          }

          const payloadWithCreator = {
            ...payload,
            createdByAccountId: actor.principal.accountId,
          };

          const existingOrganizations = yield* service.listOrganizations();
          const organizationExists = existingOrganizations.some(
            (organization) => organization.id === payload.id,
          );

          if (!organizationExists) {
            return yield* service.upsertOrganization({ payload: payloadWithCreator });
          }

          return yield* withPolicy(requireManageOrganization(payload.id))(
            service.upsertOrganization({ payload: payloadWithCreator }),
          ).pipe(Effect.provideService(Actor, actor));
        }).pipe(
          Effect.catchTag("ActorUnauthenticatedError", (cause) =>
            toUnauthorizedError("organizations.upsert", cause),
          ),
          Effect.catchTag("ActorForbiddenError", (cause) =>
            toForbiddenError("organizations.upsert", cause),
          ),
          Effect.catchTag("SourceStoreError", (cause) =>
            toStorageError("organizations.upsert", cause),
          ),
        ),
      ),
);
