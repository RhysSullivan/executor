import {
  type Approval,
  type Organization,
  type OrganizationMembership,
  type Policy,
  type Profile,
  type StorageInstance,
  type Workspace,
} from "@executor-v2/schema";
import { asc, desc, eq } from "drizzle-orm";

import {
  createDrizzleContext,
  type DrizzleDb,
  type DrizzleTables,
  type SqlAdapter,
} from "./sql-internals";

type WriteLocked = <A>(run: () => Promise<A>) => Promise<A>;

type CoreOperationsInput = {
  adapter: SqlAdapter;
  db: DrizzleDb;
  tables: DrizzleTables;
  writeLocked: WriteLocked;
};

const toOrganization = (
  row: DrizzleTables["organizationsTable"]["$inferSelect"],
): Organization => ({
  id: row.id as Organization["id"],
  slug: row.slug,
  name: row.name,
  status: row.status as Organization["status"],
  createdByAccountId: row.createdByAccountId as Organization["createdByAccountId"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toOrganizationMembership = (
  row: DrizzleTables["organizationMembershipsTable"]["$inferSelect"],
): OrganizationMembership => ({
  id: row.id as OrganizationMembership["id"],
  organizationId: row.organizationId as OrganizationMembership["organizationId"],
  accountId: row.accountId as OrganizationMembership["accountId"],
  role: row.role as OrganizationMembership["role"],
  status: row.status as OrganizationMembership["status"],
  billable: row.billable,
  invitedByAccountId:
    row.invitedByAccountId as OrganizationMembership["invitedByAccountId"],
  joinedAt: row.joinedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toWorkspace = (
  row: DrizzleTables["workspacesTable"]["$inferSelect"],
): Workspace => ({
  id: row.id as Workspace["id"],
  organizationId: row.organizationId as Workspace["organizationId"],
  name: row.name,
  createdByAccountId: row.createdByAccountId as Workspace["createdByAccountId"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toStorageInstance = (
  row: DrizzleTables["storageInstancesTable"]["$inferSelect"],
): StorageInstance => ({
  id: row.id as StorageInstance["id"],
  scopeType: row.scopeType as StorageInstance["scopeType"],
  durability: row.durability as StorageInstance["durability"],
  status: row.status as StorageInstance["status"],
  provider: row.provider as StorageInstance["provider"],
  backendKey: row.backendKey,
  organizationId: row.organizationId as StorageInstance["organizationId"],
  workspaceId: row.workspaceId as StorageInstance["workspaceId"],
  accountId: row.accountId as StorageInstance["accountId"],
  createdByAccountId: row.createdByAccountId as StorageInstance["createdByAccountId"],
  purpose: row.purpose,
  sizeBytes: row.sizeBytes,
  fileCount: row.fileCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastSeenAt: row.lastSeenAt,
  closedAt: row.closedAt,
  expiresAt: row.expiresAt,
});

const toPolicy = (
  row: DrizzleTables["policiesTable"]["$inferSelect"],
): Policy => ({
  id: row.id as Policy["id"],
  workspaceId: row.workspaceId as Policy["workspaceId"],
  toolPathPattern: row.toolPathPattern,
  decision: row.decision as Policy["decision"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toApproval = (
  row: DrizzleTables["approvalsTable"]["$inferSelect"],
): Approval => ({
  id: row.id as Approval["id"],
  workspaceId: row.workspaceId as Approval["workspaceId"],
  taskRunId: row.taskRunId as Approval["taskRunId"],
  callId: row.callId,
  toolPath: row.toolPath,
  status: row.status as Approval["status"],
  inputPreviewJson: row.inputPreviewJson,
  reason: row.reason,
  requestedAt: row.requestedAt,
  resolvedAt: row.resolvedAt,
});

const toProfile = (row: DrizzleTables["profileTable"]["$inferSelect"]): Profile => ({
  id: row.id as Profile["id"],
  defaultWorkspaceId: row.defaultWorkspaceId as Profile["defaultWorkspaceId"],
  displayName: row.displayName,
  runtimeMode: row.runtimeMode as Profile["runtimeMode"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createCoreRowOperations = ({
  adapter,
  db,
  tables,
  writeLocked,
}: CoreOperationsInput) => {
  const listOrganizationsRows = async (): Promise<Array<Organization>> => {
    const rows = await db.select().from(tables.organizationsTable).orderBy(
      asc(tables.organizationsTable.updatedAt),
      asc(tables.organizationsTable.id),
    );

    return rows.map(toOrganization);
  };

  const upsertOrganizationRow = async (organization: Organization): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.organizationsTable)
          .values({
            id: organization.id,
            slug: organization.slug,
            name: organization.name,
            status: organization.status,
            createdByAccountId: organization.createdByAccountId,
            createdAt: organization.createdAt,
            updatedAt: organization.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.organizationsTable.id,
            set: {
              slug: organization.slug,
              name: organization.name,
              status: organization.status,
              createdByAccountId: organization.createdByAccountId,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
            },
          });
      });
    });
  };

  const listOrganizationMembershipRows = async (): Promise<
    Array<OrganizationMembership>
  > => {
    const rows = await db.select().from(tables.organizationMembershipsTable).orderBy(
      asc(tables.organizationMembershipsTable.updatedAt),
      asc(tables.organizationMembershipsTable.id),
    );

    return rows.map(toOrganizationMembership);
  };

  const upsertOrganizationMembershipRow = async (
    membership: OrganizationMembership,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.organizationMembershipsTable)
          .values({
            id: membership.id,
            organizationId: membership.organizationId,
            accountId: membership.accountId,
            role: membership.role,
            status: membership.status,
            billable: membership.billable,
            invitedByAccountId: membership.invitedByAccountId,
            joinedAt: membership.joinedAt,
            createdAt: membership.createdAt,
            updatedAt: membership.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.organizationMembershipsTable.id,
            set: {
              organizationId: membership.organizationId,
              accountId: membership.accountId,
              role: membership.role,
              status: membership.status,
              billable: membership.billable,
              invitedByAccountId: membership.invitedByAccountId,
              joinedAt: membership.joinedAt,
              createdAt: membership.createdAt,
              updatedAt: membership.updatedAt,
            },
          });
      });
    });
  };

  const listWorkspaceRows = async (): Promise<Array<Workspace>> => {
    const rows = await db.select().from(tables.workspacesTable).orderBy(
      asc(tables.workspacesTable.updatedAt),
      asc(tables.workspacesTable.id),
    );

    return rows.map(toWorkspace);
  };

  const upsertWorkspaceRow = async (workspace: Workspace): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.workspacesTable)
          .values({
            id: workspace.id,
            organizationId: workspace.organizationId,
            name: workspace.name,
            createdByAccountId: workspace.createdByAccountId,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.workspacesTable.id,
            set: {
              organizationId: workspace.organizationId,
              name: workspace.name,
              createdByAccountId: workspace.createdByAccountId,
              createdAt: workspace.createdAt,
              updatedAt: workspace.updatedAt,
            },
          });
      });
    });
  };

  const listStorageInstanceRows = async (): Promise<Array<StorageInstance>> => {
    const rows = await db.select().from(tables.storageInstancesTable).orderBy(
      asc(tables.storageInstancesTable.updatedAt),
      asc(tables.storageInstancesTable.id),
    );

    return rows.map(toStorageInstance);
  };

  const upsertStorageInstanceRow = async (
    storageInstance: StorageInstance,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.storageInstancesTable)
          .values({
            id: storageInstance.id,
            scopeType: storageInstance.scopeType,
            durability: storageInstance.durability,
            status: storageInstance.status,
            provider: storageInstance.provider,
            backendKey: storageInstance.backendKey,
            organizationId: storageInstance.organizationId,
            workspaceId: storageInstance.workspaceId,
            accountId: storageInstance.accountId,
            createdByAccountId: storageInstance.createdByAccountId,
            purpose: storageInstance.purpose,
            sizeBytes: storageInstance.sizeBytes,
            fileCount: storageInstance.fileCount,
            createdAt: storageInstance.createdAt,
            updatedAt: storageInstance.updatedAt,
            lastSeenAt: storageInstance.lastSeenAt,
            closedAt: storageInstance.closedAt,
            expiresAt: storageInstance.expiresAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.storageInstancesTable.id,
            set: {
              scopeType: storageInstance.scopeType,
              durability: storageInstance.durability,
              status: storageInstance.status,
              provider: storageInstance.provider,
              backendKey: storageInstance.backendKey,
              organizationId: storageInstance.organizationId,
              workspaceId: storageInstance.workspaceId,
              accountId: storageInstance.accountId,
              createdByAccountId: storageInstance.createdByAccountId,
              purpose: storageInstance.purpose,
              sizeBytes: storageInstance.sizeBytes,
              fileCount: storageInstance.fileCount,
              createdAt: storageInstance.createdAt,
              updatedAt: storageInstance.updatedAt,
              lastSeenAt: storageInstance.lastSeenAt,
              closedAt: storageInstance.closedAt,
              expiresAt: storageInstance.expiresAt,
            },
          });
      });
    });
  };

  const removeStorageInstanceRowById = async (
    storageInstanceId: StorageInstance["id"],
  ): Promise<boolean> =>
    writeLocked(async () =>
      adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const existing = await transactionContext.db
          .select({ id: transactionContext.tables.storageInstancesTable.id })
          .from(transactionContext.tables.storageInstancesTable)
          .where(eq(transactionContext.tables.storageInstancesTable.id, storageInstanceId))
          .limit(1);

        if (existing.length === 0) {
          return false;
        }

        await transactionContext.db
          .delete(transactionContext.tables.storageInstancesTable)
          .where(eq(transactionContext.tables.storageInstancesTable.id, storageInstanceId));

        return true;
      })
    );

  const listPolicyRows = async (): Promise<Array<Policy>> => {
    const rows = await db.select().from(tables.policiesTable).orderBy(
      asc(tables.policiesTable.updatedAt),
      asc(tables.policiesTable.id),
    );

    return rows.map(toPolicy);
  };

  const upsertPolicyRow = async (policy: Policy): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.policiesTable)
          .values({
            id: policy.id,
            workspaceId: policy.workspaceId,
            toolPathPattern: policy.toolPathPattern,
            decision: policy.decision,
            createdAt: policy.createdAt,
            updatedAt: policy.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.policiesTable.id,
            set: {
              workspaceId: policy.workspaceId,
              toolPathPattern: policy.toolPathPattern,
              decision: policy.decision,
              createdAt: policy.createdAt,
              updatedAt: policy.updatedAt,
            },
          });
      });
    });
  };

  const removePolicyRowById = async (policyId: Policy["id"]): Promise<boolean> =>
    writeLocked(async () =>
      adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        const existing = await transactionContext.db
          .select({ id: transactionContext.tables.policiesTable.id })
          .from(transactionContext.tables.policiesTable)
          .where(eq(transactionContext.tables.policiesTable.id, policyId))
          .limit(1);

        if (existing.length === 0) {
          return false;
        }

        await transactionContext.db
          .delete(transactionContext.tables.policiesTable)
          .where(eq(transactionContext.tables.policiesTable.id, policyId));

        return true;
      })
    );

  const listApprovalRows = async (): Promise<Array<Approval>> => {
    const rows = await db.select().from(tables.approvalsTable).orderBy(
      asc(tables.approvalsTable.requestedAt),
      asc(tables.approvalsTable.id),
    );

    return rows.map(toApproval);
  };

  const upsertApprovalRow = async (approval: Approval): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.approvalsTable)
          .values({
            id: approval.id,
            workspaceId: approval.workspaceId,
            taskRunId: approval.taskRunId,
            callId: approval.callId,
            toolPath: approval.toolPath,
            status: approval.status,
            inputPreviewJson: approval.inputPreviewJson,
            reason: approval.reason,
            requestedAt: approval.requestedAt,
            resolvedAt: approval.resolvedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.approvalsTable.id,
            set: {
              workspaceId: approval.workspaceId,
              taskRunId: approval.taskRunId,
              callId: approval.callId,
              toolPath: approval.toolPath,
              status: approval.status,
              inputPreviewJson: approval.inputPreviewJson,
              reason: approval.reason,
              requestedAt: approval.requestedAt,
              resolvedAt: approval.resolvedAt,
            },
          });
      });
    });
  };

  const getProfileRow = async (): Promise<Profile | null> => {
    const rows = await db.select().from(tables.profileTable).orderBy(
      desc(tables.profileTable.updatedAt),
      asc(tables.profileTable.id),
    ).limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return toProfile(row);
  };

  const upsertProfileRow = async (profile: Profile): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.profileTable)
          .values({
            id: profile.id,
            defaultWorkspaceId: profile.defaultWorkspaceId,
            displayName: profile.displayName,
            runtimeMode: profile.runtimeMode,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.profileTable.id,
            set: {
              defaultWorkspaceId: profile.defaultWorkspaceId,
              displayName: profile.displayName,
              runtimeMode: profile.runtimeMode,
              createdAt: profile.createdAt,
              updatedAt: profile.updatedAt,
            },
          });
      });
    });
  };

  return {
    listOrganizationsRows,
    upsertOrganizationRow,
    listOrganizationMembershipRows,
    upsertOrganizationMembershipRow,
    listWorkspaceRows,
    upsertWorkspaceRow,
    listStorageInstanceRows,
    upsertStorageInstanceRow,
    removeStorageInstanceRowById,
    listPolicyRows,
    upsertPolicyRow,
    removePolicyRowById,
    listApprovalRows,
    upsertApprovalRow,
    getProfileRow,
    upsertProfileRow,
  };
};
