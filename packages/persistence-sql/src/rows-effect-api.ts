import {
  type Approval,
  type AuthConnection,
  type AuthMaterial,
  type OAuthState,
  type Organization,
  type OrganizationMembership,
  type Policy,
  type Profile,
  type SourceAuthBinding,
  type StorageInstance,
  type Workspace,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { toRowStoreError } from "./persistence-errors";
import { createRowOperations } from "./row-operations";
import { tableNames } from "./schema";
import { type SqlBackend } from "./sql-internals";

type RowOperations = ReturnType<typeof createRowOperations>;

const toListEffect = <A>(
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<ReadonlyArray<A>>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

const toVoidEffect = (
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<void>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

const toBooleanEffect = (
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<boolean>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

const toOptionEffect = <A>(
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<A | null>,
) =>
  Effect.tryPromise({
    try: async () => {
      const value = await run();
      return value === null ? Option.none<A>() : Option.some(value);
    },
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

export const createRowsEffectApi = (
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

  authConnections: {
    list: () =>
      toListEffect<AuthConnection>(
        backend,
        "rows.authConnections.list",
        tableNames.authConnections,
        operations.listAuthConnectionRows,
      ),
    upsert: (connection: AuthConnection) =>
      toVoidEffect(
        backend,
        "rows.authConnections.upsert",
        tableNames.authConnections,
        () => operations.upsertAuthConnectionRow(connection),
      ),
    removeById: (connectionId: AuthConnection["id"]) =>
      toBooleanEffect(
        backend,
        "rows.authConnections.remove",
        tableNames.authConnections,
        () => operations.removeAuthConnectionRowById(connectionId),
      ),
  },

  sourceAuthBindings: {
    list: () =>
      toListEffect<SourceAuthBinding>(
        backend,
        "rows.sourceAuthBindings.list",
        tableNames.sourceAuthBindings,
        operations.listSourceAuthBindingRows,
      ),
    upsert: (binding: SourceAuthBinding) =>
      toVoidEffect(
        backend,
        "rows.sourceAuthBindings.upsert",
        tableNames.sourceAuthBindings,
        () => operations.upsertSourceAuthBindingRow(binding),
      ),
    removeById: (bindingId: SourceAuthBinding["id"]) =>
      toBooleanEffect(
        backend,
        "rows.sourceAuthBindings.remove",
        tableNames.sourceAuthBindings,
        () => operations.removeSourceAuthBindingRowById(bindingId),
      ),
  },

  authMaterials: {
    list: () =>
      toListEffect<AuthMaterial>(
        backend,
        "rows.authMaterials.list",
        tableNames.authMaterials,
        operations.listAuthMaterialRows,
      ),
    upsert: (material: AuthMaterial) =>
      toVoidEffect(
        backend,
        "rows.authMaterials.upsert",
        tableNames.authMaterials,
        () => operations.upsertAuthMaterialRow(material),
      ),
    removeByConnectionId: (connectionId: AuthMaterial["connectionId"]) =>
      toVoidEffect(
        backend,
        "rows.authMaterials.remove_by_connection",
        tableNames.authMaterials,
        () => operations.removeAuthMaterialRowsByConnectionId(connectionId),
      ),
  },

  oauthStates: {
    list: () =>
      toListEffect<OAuthState>(
        backend,
        "rows.oauthStates.list",
        tableNames.oauthStates,
        operations.listOAuthStateRows,
      ),
    upsert: (state: OAuthState) =>
      toVoidEffect(
        backend,
        "rows.oauthStates.upsert",
        tableNames.oauthStates,
        () => operations.upsertOAuthStateRow(state),
      ),
    removeByConnectionId: (connectionId: OAuthState["connectionId"]) =>
      toVoidEffect(
        backend,
        "rows.oauthStates.remove_by_connection",
        tableNames.oauthStates,
        () => operations.removeOAuthStateRowsByConnectionId(connectionId),
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
