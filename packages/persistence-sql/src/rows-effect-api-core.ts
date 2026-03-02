import {
  type Approval,
  type Organization,
  type OrganizationMembership,
  type Policy,
  type Profile,
  type StorageInstance,
  type Workspace,
} from "@executor-v2/schema";

import { tableNames } from "./schema";
import { type SqlBackend } from "./sql-internals";
import {
  type RowOperations,
  toBooleanEffect,
  toListEffect,
  toOptionEffect,
  toVoidEffect,
} from "./rows-effect-helpers";

export const createCoreRowsEffectApi = (
  backend: SqlBackend,
  operations: RowOperations,
) => ({
  profile: {
    get: () =>
      toOptionEffect<Profile>(
        backend,
        "rows.profile.get",
        tableNames.profile,
        operations.getProfileRow,
      ),
    upsert: (profile: Profile) =>
      toVoidEffect(
        backend,
        "rows.profile.upsert",
        tableNames.profile,
        () => operations.upsertProfileRow(profile),
      ),
  },

  organizations: {
    list: () =>
      toListEffect<Organization>(
        backend,
        "rows.organizations.list",
        tableNames.organizations,
        operations.listOrganizationsRows,
      ),
    upsert: (organization: Organization) =>
      toVoidEffect(
        backend,
        "rows.organizations.upsert",
        tableNames.organizations,
        () => operations.upsertOrganizationRow(organization),
      ),
  },

  organizationMemberships: {
    list: () =>
      toListEffect<OrganizationMembership>(
        backend,
        "rows.organizationMemberships.list",
        tableNames.organizationMemberships,
        operations.listOrganizationMembershipRows,
      ),
    upsert: (membership: OrganizationMembership) =>
      toVoidEffect(
        backend,
        "rows.organizationMemberships.upsert",
        tableNames.organizationMemberships,
        () => operations.upsertOrganizationMembershipRow(membership),
      ),
  },

  workspaces: {
    list: () =>
      toListEffect<Workspace>(
        backend,
        "rows.workspaces.list",
        tableNames.workspaces,
        operations.listWorkspaceRows,
      ),
    upsert: (workspace: Workspace) =>
      toVoidEffect(
        backend,
        "rows.workspaces.upsert",
        tableNames.workspaces,
        () => operations.upsertWorkspaceRow(workspace),
      ),
  },

  storageInstances: {
    list: () =>
      toListEffect<StorageInstance>(
        backend,
        "rows.storageInstances.list",
        tableNames.storageInstances,
        operations.listStorageInstanceRows,
      ),
    upsert: (storageInstance: StorageInstance) =>
      toVoidEffect(
        backend,
        "rows.storageInstances.upsert",
        tableNames.storageInstances,
        () => operations.upsertStorageInstanceRow(storageInstance),
      ),
    removeById: (storageInstanceId: StorageInstance["id"]) =>
      toBooleanEffect(
        backend,
        "rows.storageInstances.remove",
        tableNames.storageInstances,
        () => operations.removeStorageInstanceRowById(storageInstanceId),
      ),
  },

  policies: {
    list: () =>
      toListEffect<Policy>(
        backend,
        "rows.policies.list",
        tableNames.policies,
        operations.listPolicyRows,
      ),
    upsert: (policy: Policy) =>
      toVoidEffect(
        backend,
        "rows.policies.upsert",
        tableNames.policies,
        () => operations.upsertPolicyRow(policy),
      ),
    removeById: (policyId: Policy["id"]) =>
      toBooleanEffect(
        backend,
        "rows.policies.remove",
        tableNames.policies,
        () => operations.removePolicyRowById(policyId),
      ),
  },

  approvals: {
    list: () =>
      toListEffect<Approval>(
        backend,
        "rows.approvals.list",
        tableNames.approvals,
        operations.listApprovalRows,
      ),
    upsert: (approval: Approval) =>
      toVoidEffect(
        backend,
        "rows.approvals.upsert",
        tableNames.approvals,
        () => operations.upsertApprovalRow(approval),
      ),
  },
});
