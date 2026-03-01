import {
  RolePermissions,
  type OrganizationId,
  type OrganizationMembership,
  type Permission,
  type Principal,
  type WorkspaceId,
  type WorkspaceMembership,
} from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ActorUnauthenticatedError extends Data.TaggedError(
  "ActorUnauthenticatedError",
)<{
  message: string;
}> {}

export class ActorForbiddenError extends Data.TaggedError("ActorForbiddenError")<{
  permission: Permission;
  scope: string;
}> {}

export type PermissionRequest = {
  permission: Permission;
  workspaceId?: WorkspaceId;
  organizationId?: OrganizationId;
};

export type ActorShape = {
  principal: Principal;
  workspaceMemberships: ReadonlyArray<WorkspaceMembership>;
  organizationMemberships: ReadonlyArray<OrganizationMembership>;
  hasPermission: (request: PermissionRequest) => boolean;
  requirePermission: (
    request: PermissionRequest,
  ) => Effect.Effect<void, ActorForbiddenError>;
  hasWorkspaceAccess: (workspaceId: WorkspaceId) => boolean;
  requireWorkspaceAccess: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<void, ActorForbiddenError>;
};

export class Actor extends Context.Tag("@executor-v2/domain/auth/Actor")<
  Actor,
  ActorShape
>() {}

export type MakeActorInput = {
  principal: Principal | null;
  workspaceMemberships: ReadonlyArray<WorkspaceMembership>;
  organizationMemberships: ReadonlyArray<OrganizationMembership>;
};

const isWorkspaceMembershipActive = (
  membership: WorkspaceMembership,
): boolean => membership.status === "active";

const isOrganizationMembershipActive = (
  membership: OrganizationMembership,
): boolean => membership.status === "active";

const permissionsByWorkspaceRole = new Map(
  Object.entries(RolePermissions).map(([role, permissions]) => [
    role,
    new Set<Permission>(permissions),
  ]),
);

const permissionsForRole = (role: keyof typeof RolePermissions): ReadonlySet<Permission> =>
  permissionsByWorkspaceRole.get(role) ?? new Set<Permission>();

const hasPermissionInWorkspace = (
  request: PermissionRequest,
  memberships: ReadonlyArray<WorkspaceMembership>,
): boolean => {
  if (request.workspaceId === undefined) {
    return false;
  }

  return memberships.some((membership) => {
    if (!isWorkspaceMembershipActive(membership)) {
      return false;
    }

    if (membership.workspaceId !== request.workspaceId) {
      return false;
    }

    return permissionsForRole(membership.role).has(request.permission);
  });
};

const hasPermissionInOrganization = (
  request: PermissionRequest,
  memberships: ReadonlyArray<OrganizationMembership>,
): boolean => {
  if (request.organizationId === undefined) {
    return false;
  }

  return memberships.some((membership) => {
    if (!isOrganizationMembershipActive(membership)) {
      return false;
    }

    if (membership.organizationId !== request.organizationId) {
      return false;
    }

    return permissionsForRole(membership.role).has(request.permission);
  });
};

const hasPermissionGlobally = (
  request: PermissionRequest,
  workspaceMemberships: ReadonlyArray<WorkspaceMembership>,
  organizationMemberships: ReadonlyArray<OrganizationMembership>,
): boolean => {
  const workspaceAllowed = workspaceMemberships.some(
    (membership) =>
      isWorkspaceMembershipActive(membership) &&
      permissionsForRole(membership.role).has(request.permission),
  );

  if (workspaceAllowed) {
    return true;
  }

  return organizationMemberships.some(
    (membership) =>
      isOrganizationMembershipActive(membership) &&
      permissionsForRole(membership.role).has(request.permission),
  );
};

const scopeLabel = (request: PermissionRequest): string => {
  if (request.workspaceId !== undefined) {
    return `workspace:${request.workspaceId}`;
  }

  if (request.organizationId !== undefined) {
    return `organization:${request.organizationId}`;
  }

  return "global";
};

const toWorkspaceAccessPermissionRequest = (
  workspaceId: WorkspaceId,
): PermissionRequest => ({
  permission: "workspace:read",
  workspaceId,
});

const toActorShape = (input: {
  principal: Principal;
  workspaceMemberships: ReadonlyArray<WorkspaceMembership>;
  organizationMemberships: ReadonlyArray<OrganizationMembership>;
}): ActorShape => {
  const hasPermission = (request: PermissionRequest): boolean => {
    if (request.workspaceId !== undefined) {
      return hasPermissionInWorkspace(request, input.workspaceMemberships);
    }

    if (request.organizationId !== undefined) {
      return hasPermissionInOrganization(request, input.organizationMemberships);
    }

    return hasPermissionGlobally(
      request,
      input.workspaceMemberships,
      input.organizationMemberships,
    );
  };

  const requirePermission = (
    request: PermissionRequest,
  ): Effect.Effect<void, ActorForbiddenError> =>
    hasPermission(request)
      ? Effect.void
      : Effect.fail(
          new ActorForbiddenError({
            permission: request.permission,
            scope: scopeLabel(request),
          }),
        );

  const hasWorkspaceAccess = (workspaceId: WorkspaceId): boolean =>
    hasPermission(toWorkspaceAccessPermissionRequest(workspaceId));

  const requireWorkspaceAccess = (
    workspaceId: WorkspaceId,
  ): Effect.Effect<void, ActorForbiddenError> =>
    requirePermission(toWorkspaceAccessPermissionRequest(workspaceId));

  return {
    principal: input.principal,
    workspaceMemberships: input.workspaceMemberships,
    organizationMemberships: input.organizationMemberships,
    hasPermission,
    requirePermission,
    hasWorkspaceAccess,
    requireWorkspaceAccess,
  };
};

export const makeActor = (
  input: MakeActorInput,
): Effect.Effect<ActorShape, ActorUnauthenticatedError> =>
  input.principal === null
    ? Effect.fail(
        new ActorUnauthenticatedError({
          message: "Authenticated principal is required",
        }),
      )
    : Effect.succeed(toActorShape({
        principal: input.principal,
        workspaceMemberships: input.workspaceMemberships,
        organizationMemberships: input.organizationMemberships,
      }));

export const ActorLive = (actor: ActorShape): Layer.Layer<Actor> =>
  Layer.succeed(Actor, actor);
