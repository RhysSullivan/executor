import {
  type Approval,
  type Organization,
  type OrganizationMembership,
  type Policy,
  type Profile,
  type StorageInstance,
  type Workspace,
} from "@executor-v2/schema";
import { asc, eq } from "drizzle-orm";

import {
  ApprovalJson,
  OrganizationJson,
  OrganizationMembershipJson,
  PolicyJson,
  ProfileJson,
  StorageInstanceJson,
  WorkspaceJson,
} from "./persistence-codecs";
import { createDrizzleContext, type DrizzleDb, type DrizzleTables, type SqlAdapter } from "./sql-internals";

type WriteLocked = <A>(run: () => Promise<A>) => Promise<A>;

type CoreOperationsInput = {
  adapter: SqlAdapter;
  db: DrizzleDb;
  tables: DrizzleTables;
  writeLocked: WriteLocked;
};

export const createCoreRowOperations = ({
  adapter,
  db,
  tables,
  writeLocked,
}: CoreOperationsInput) => {
  const listOrganizationsRows = async (): Promise<Array<Organization>> => {
    const rows = await db
      .select({ payloadJson: tables.organizationsTable.payloadJson })
      .from(tables.organizationsTable)
      .orderBy(
        asc(tables.organizationsTable.updatedAt),
        asc(tables.organizationsTable.id),
      );

    return rows.map((row) => OrganizationJson.decode(row.payloadJson));
  };

  const upsertOrganizationRow = async (
    organization: Organization,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = OrganizationJson.encode(organization);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.organizationsTable)
          .values({
            id: organization.id,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.organizationsTable.id,
            set: {
              payloadJson,
              updatedAt: now,
            },
          });
      });
    });
  };

  const listOrganizationMembershipRows = async (): Promise<
    Array<OrganizationMembership>
  > => {
    const rows = await db
      .select({ payloadJson: tables.organizationMembershipsTable.payloadJson })
      .from(tables.organizationMembershipsTable)
      .orderBy(
        asc(tables.organizationMembershipsTable.updatedAt),
        asc(tables.organizationMembershipsTable.id),
      );

    return rows.map((row) => OrganizationMembershipJson.decode(row.payloadJson));
  };

  const upsertOrganizationMembershipRow = async (
    membership: OrganizationMembership,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = OrganizationMembershipJson.encode(membership);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.organizationMembershipsTable)
          .values({
            id: membership.id,
            workspaceId: null,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.organizationMembershipsTable.id,
            set: {
              workspaceId: null,
              payloadJson,
              updatedAt: now,
            },
          });
      });
    });
  };

  const listWorkspaceRows = async (): Promise<Array<Workspace>> => {
    const rows = await db
      .select({ payloadJson: tables.workspacesTable.payloadJson })
      .from(tables.workspacesTable)
      .orderBy(
        asc(tables.workspacesTable.updatedAt),
        asc(tables.workspacesTable.id),
      );

    return rows.map((row) => WorkspaceJson.decode(row.payloadJson));
  };

  const upsertWorkspaceRow = async (workspace: Workspace): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = WorkspaceJson.encode(workspace);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.workspacesTable)
          .values({
            id: workspace.id,
            workspaceId: workspace.organizationId,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.workspacesTable.id,
            set: {
              workspaceId: workspace.organizationId,
              payloadJson,
              updatedAt: now,
            },
          });
      });
    });
  };

  const listStorageInstanceRows = async (): Promise<Array<StorageInstance>> => {
    const rows = await db
      .select({ payloadJson: tables.storageInstancesTable.payloadJson })
      .from(tables.storageInstancesTable)
      .orderBy(
        asc(tables.storageInstancesTable.updatedAt),
        asc(tables.storageInstancesTable.id),
      );

    return rows.map((row) => StorageInstanceJson.decode(row.payloadJson));
  };

  const upsertStorageInstanceRow = async (
    storageInstance: StorageInstance,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = StorageInstanceJson.encode(storageInstance);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.storageInstancesTable)
          .values({
            id: storageInstance.id,
            workspaceId: storageInstance.workspaceId,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.storageInstancesTable.id,
            set: {
              workspaceId: storageInstance.workspaceId,
              payloadJson,
              updatedAt: now,
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
    const rows = await db
      .select({ payloadJson: tables.policiesTable.payloadJson })
      .from(tables.policiesTable)
      .orderBy(asc(tables.policiesTable.updatedAt), asc(tables.policiesTable.id));

    return rows.map((row) => PolicyJson.decode(row.payloadJson));
  };

  const upsertPolicyRow = async (policy: Policy): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = PolicyJson.encode(policy);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.policiesTable)
          .values({
            id: policy.id,
            workspaceId: policy.workspaceId,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.policiesTable.id,
            set: {
              workspaceId: policy.workspaceId,
              payloadJson,
              updatedAt: now,
            },
          });
      });
    });
  };

  const removePolicyRowById = async (policyId: Policy["id"]): Promise<boolean> => {
    return writeLocked(async () =>
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
  };

  const listApprovalRows = async (): Promise<Array<Approval>> => {
    const rows = await db
      .select({ payloadJson: tables.approvalsTable.payloadJson })
      .from(tables.approvalsTable)
      .orderBy(asc(tables.approvalsTable.updatedAt), asc(tables.approvalsTable.id));

    return rows.map((row) => ApprovalJson.decode(row.payloadJson));
  };

  const upsertApprovalRow = async (approval: Approval): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = ApprovalJson.encode(approval);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.approvalsTable)
          .values({
            id: approval.id,
            workspaceId: approval.workspaceId,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.approvalsTable.id,
            set: {
              workspaceId: approval.workspaceId,
              payloadJson,
              updatedAt: now,
            },
          });
      });
    });
  };

  const getProfileRow = async (): Promise<Profile | null> => {
    const rows = await db
      .select({ profileJson: tables.profileTable.profileJson })
      .from(tables.profileTable)
      .where(eq(tables.profileTable.id, 1))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return ProfileJson.decode(row.profileJson);
  };

  const upsertProfileRow = async (profile: Profile): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const currentRows = await transactionContext.db
          .select({ schemaVersion: transactionContext.tables.profileTable.schemaVersion })
          .from(transactionContext.tables.profileTable)
          .where(eq(transactionContext.tables.profileTable.id, 1))
          .limit(1);

        const schemaVersion = currentRows[0]?.schemaVersion ?? 1;
        const now = Date.now();
        const profileJson = ProfileJson.encode(profile);

        await transactionContext.db
          .insert(transactionContext.tables.profileTable)
          .values({
            id: 1,
            schemaVersion,
            generatedAt: now,
            profileJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.profileTable.id,
            set: {
              profileJson,
              generatedAt: now,
              updatedAt: now,
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
