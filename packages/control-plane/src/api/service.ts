import type {
  AccountId,
  Organization,
  OrganizationId,
  OrganizationMembership,
  Policy,
  PolicyId,
  Source,
  SourceId,
  Workspace,
  WorkspaceId,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type {
  CreateMembershipPayload,
  UpdateMembershipPayload,
} from "./memberships/api";
import type {
  CreateOrganizationPayload,
  UpdateOrganizationPayload,
} from "./organizations/api";
import type {
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "./policies/api";
import type {
  CreateSourcePayload,
  UpdateSourcePayload,
} from "./sources/api";
import type {
  CreateWorkspacePayload,
  UpdateWorkspacePayload,
} from "./workspaces/api";
import type {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "./errors";

export type CreateOrganizationInput = {
  payload: CreateOrganizationPayload;
  createdByAccountId?: Organization["createdByAccountId"];
};

export type UpdateOrganizationInput = {
  organizationId: OrganizationId;
  payload: UpdateOrganizationPayload;
};

export type RemoveOrganizationInput = {
  organizationId: OrganizationId;
};

export type CreateMembershipInput = {
  organizationId: OrganizationId;
  payload: CreateMembershipPayload;
};

export type UpdateMembershipInput = {
  organizationId: OrganizationId;
  accountId: AccountId;
  payload: UpdateMembershipPayload;
};

export type RemoveMembershipInput = {
  organizationId: OrganizationId;
  accountId: AccountId;
};

export type CreateWorkspaceInput = {
  organizationId: OrganizationId;
  payload: CreateWorkspacePayload;
  createdByAccountId?: Workspace["createdByAccountId"];
};

export type UpdateWorkspaceInput = {
  workspaceId: WorkspaceId;
  payload: UpdateWorkspacePayload;
};

export type RemoveWorkspaceInput = {
  workspaceId: WorkspaceId;
};

export type CreateSourceInput = {
  workspaceId: WorkspaceId;
  payload: CreateSourcePayload;
};

export type GetSourceInput = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
};

export type UpdateSourceInput = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  payload: UpdateSourcePayload;
};

export type RemoveSourceInput = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
};

export type CreatePolicyInput = {
  workspaceId: WorkspaceId;
  payload: CreatePolicyPayload;
};

export type GetPolicyInput = {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
};

export type UpdatePolicyInput = {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
  payload: UpdatePolicyPayload;
};

export type RemovePolicyInput = {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
};

export type ControlPlaneServiceShape = {
  listOrganizations: (input: {
    accountId: AccountId;
  }) => Effect.Effect<ReadonlyArray<Organization>, ControlPlaneStorageError>;
  createOrganization: (
    input: CreateOrganizationInput,
  ) => Effect.Effect<Organization, ControlPlaneBadRequestError | ControlPlaneStorageError>;
  getOrganization: (input: {
    organizationId: OrganizationId;
    accountId: AccountId;
  }) => Effect.Effect<Organization, ControlPlaneNotFoundError | ControlPlaneStorageError>;
  updateOrganization: (
    input: UpdateOrganizationInput,
  ) => Effect.Effect<
    Organization,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  removeOrganization: (
    input: RemoveOrganizationInput,
  ) => Effect.Effect<{ removed: boolean }, ControlPlaneStorageError>;

  listMemberships: (
    organizationId: OrganizationId,
  ) => Effect.Effect<
    ReadonlyArray<OrganizationMembership>,
    ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  createMembership: (
    input: CreateMembershipInput,
  ) => Effect.Effect<
    OrganizationMembership,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  updateMembership: (
    input: UpdateMembershipInput,
  ) => Effect.Effect<
    OrganizationMembership,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  removeMembership: (
    input: RemoveMembershipInput,
  ) => Effect.Effect<{ removed: boolean }, ControlPlaneNotFoundError | ControlPlaneStorageError>;

  listWorkspaces: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<Workspace>, ControlPlaneNotFoundError | ControlPlaneStorageError>;
  createWorkspace: (
    input: CreateWorkspaceInput,
  ) => Effect.Effect<
    Workspace,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  getWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Workspace, ControlPlaneNotFoundError | ControlPlaneStorageError>;
  updateWorkspace: (
    input: UpdateWorkspaceInput,
  ) => Effect.Effect<
    Workspace,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  removeWorkspace: (
    input: RemoveWorkspaceInput,
  ) => Effect.Effect<{ removed: boolean }, ControlPlaneStorageError>;

  listSources: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Source>, ControlPlaneStorageError>;
  createSource: (
    input: CreateSourceInput,
  ) => Effect.Effect<Source, ControlPlaneBadRequestError | ControlPlaneStorageError>;
  getSource: (
    input: GetSourceInput,
  ) => Effect.Effect<Source, ControlPlaneNotFoundError | ControlPlaneStorageError>;
  updateSource: (
    input: UpdateSourceInput,
  ) => Effect.Effect<
    Source,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  removeSource: (
    input: RemoveSourceInput,
  ) => Effect.Effect<{ removed: boolean }, ControlPlaneStorageError>;

  listPolicies: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Policy>, ControlPlaneStorageError>;
  createPolicy: (
    input: CreatePolicyInput,
  ) => Effect.Effect<Policy, ControlPlaneBadRequestError | ControlPlaneStorageError>;
  getPolicy: (
    input: GetPolicyInput,
  ) => Effect.Effect<Policy, ControlPlaneNotFoundError | ControlPlaneStorageError>;
  updatePolicy: (
    input: UpdatePolicyInput,
  ) => Effect.Effect<
    Policy,
    ControlPlaneBadRequestError | ControlPlaneNotFoundError | ControlPlaneStorageError
  >;
  removePolicy: (
    input: RemovePolicyInput,
  ) => Effect.Effect<{ removed: boolean }, ControlPlaneStorageError>;
};

export class ControlPlaneService extends Context.Tag(
  "#api/ControlPlaneService",
)<ControlPlaneService, ControlPlaneServiceShape>() {}
