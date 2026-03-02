import {
  type AuthConnection,
  type AuthMaterial,
  type OAuthState,
  type SourceAuthBinding,
} from "@executor-v2/schema";
import { asc, eq } from "drizzle-orm";

import {
  createDrizzleContext,
  type DrizzleDb,
  type DrizzleTables,
  type SqlAdapter,
} from "./sql-internals";

type WriteLocked = <A>(run: () => Promise<A>) => Promise<A>;

type AuthOperationsInput = {
  adapter: SqlAdapter;
  db: DrizzleDb;
  tables: DrizzleTables;
  writeLocked: WriteLocked;
};

const toAuthConnection = (
  row: DrizzleTables["authConnectionsTable"]["$inferSelect"],
): AuthConnection => ({
  id: row.id as AuthConnection["id"],
  organizationId: row.organizationId as AuthConnection["organizationId"],
  workspaceId: row.workspaceId as AuthConnection["workspaceId"],
  accountId: row.accountId as AuthConnection["accountId"],
  ownerType: row.ownerType as AuthConnection["ownerType"],
  strategy: row.strategy as AuthConnection["strategy"],
  displayName: row.displayName,
  status: row.status as AuthConnection["status"],
  statusReason: row.statusReason,
  lastAuthErrorClass: row.lastAuthErrorClass,
  metadataJson: row.metadataJson,
  additionalHeadersJson: row.additionalHeadersJson,
  createdByAccountId: row.createdByAccountId as AuthConnection["createdByAccountId"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastUsedAt: row.lastUsedAt,
});

const toSourceAuthBinding = (
  row: DrizzleTables["sourceAuthBindingsTable"]["$inferSelect"],
): SourceAuthBinding => ({
  id: row.id as SourceAuthBinding["id"],
  sourceId: row.sourceId as SourceAuthBinding["sourceId"],
  connectionId: row.connectionId as SourceAuthBinding["connectionId"],
  organizationId: row.organizationId as SourceAuthBinding["organizationId"],
  workspaceId: row.workspaceId as SourceAuthBinding["workspaceId"],
  accountId: row.accountId as SourceAuthBinding["accountId"],
  scopeType: row.scopeType as SourceAuthBinding["scopeType"],
  selector: row.selector,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toAuthMaterial = (
  row: DrizzleTables["authMaterialsTable"]["$inferSelect"],
): AuthMaterial => ({
  id: row.id as AuthMaterial["id"],
  connectionId: row.connectionId as AuthMaterial["connectionId"],
  ciphertext: row.ciphertext,
  keyVersion: row.keyVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toOAuthState = (
  row: DrizzleTables["oauthStatesTable"]["$inferSelect"],
): OAuthState => ({
  id: row.id as OAuthState["id"],
  connectionId: row.connectionId as OAuthState["connectionId"],
  accessTokenCiphertext: row.accessTokenCiphertext,
  refreshTokenCiphertext: row.refreshTokenCiphertext,
  keyVersion: row.keyVersion,
  expiresAt: row.expiresAt,
  scope: row.scope,
  tokenType: row.tokenType,
  issuer: row.issuer,
  refreshConfigJson: row.refreshConfigJson,
  tokenVersion: row.tokenVersion,
  leaseHolder: row.leaseHolder,
  leaseExpiresAt: row.leaseExpiresAt,
  leaseFence: row.leaseFence,
  lastRefreshAt: row.lastRefreshAt,
  lastRefreshErrorClass: row.lastRefreshErrorClass,
  lastRefreshError: row.lastRefreshError,
  reauthRequiredAt: row.reauthRequiredAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createAuthRowOperations = ({
  adapter,
  db,
  tables,
  writeLocked,
}: AuthOperationsInput) => {
  const listAuthConnectionRows = async (): Promise<Array<AuthConnection>> => {
    const rows = await db.select().from(tables.authConnectionsTable).orderBy(
      asc(tables.authConnectionsTable.updatedAt),
      asc(tables.authConnectionsTable.id),
    );

    return rows.map(toAuthConnection);
  };

  const upsertAuthConnectionRow = async (connection: AuthConnection): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.authConnectionsTable)
          .values({
            id: connection.id,
            organizationId: connection.organizationId,
            workspaceId: connection.workspaceId,
            accountId: connection.accountId,
            ownerType: connection.ownerType,
            strategy: connection.strategy,
            displayName: connection.displayName,
            status: connection.status,
            statusReason: connection.statusReason,
            lastAuthErrorClass: connection.lastAuthErrorClass,
            metadataJson: connection.metadataJson,
            additionalHeadersJson: connection.additionalHeadersJson,
            createdByAccountId: connection.createdByAccountId,
            createdAt: connection.createdAt,
            updatedAt: connection.updatedAt,
            lastUsedAt: connection.lastUsedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.authConnectionsTable.id,
            set: {
              organizationId: connection.organizationId,
              workspaceId: connection.workspaceId,
              accountId: connection.accountId,
              ownerType: connection.ownerType,
              strategy: connection.strategy,
              displayName: connection.displayName,
              status: connection.status,
              statusReason: connection.statusReason,
              lastAuthErrorClass: connection.lastAuthErrorClass,
              metadataJson: connection.metadataJson,
              additionalHeadersJson: connection.additionalHeadersJson,
              createdByAccountId: connection.createdByAccountId,
              createdAt: connection.createdAt,
              updatedAt: connection.updatedAt,
              lastUsedAt: connection.lastUsedAt,
            },
          });
      });
    });
  };

  const removeAuthConnectionRowById = async (
    connectionId: AuthConnection["id"],
  ): Promise<boolean> =>
    writeLocked(async () =>
      adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const existing = await transactionContext.db
          .select({ id: transactionContext.tables.authConnectionsTable.id })
          .from(transactionContext.tables.authConnectionsTable)
          .where(eq(transactionContext.tables.authConnectionsTable.id, connectionId))
          .limit(1);

        if (existing.length === 0) {
          return false;
        }

        await transactionContext.db
          .delete(transactionContext.tables.authConnectionsTable)
          .where(eq(transactionContext.tables.authConnectionsTable.id, connectionId));

        return true;
      })
    );

  const listSourceAuthBindingRows = async (): Promise<Array<SourceAuthBinding>> => {
    const rows = await db.select().from(tables.sourceAuthBindingsTable).orderBy(
      asc(tables.sourceAuthBindingsTable.updatedAt),
      asc(tables.sourceAuthBindingsTable.id),
    );

    return rows.map(toSourceAuthBinding);
  };

  const upsertSourceAuthBindingRow = async (
    binding: SourceAuthBinding,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.sourceAuthBindingsTable)
          .values({
            id: binding.id,
            sourceId: binding.sourceId,
            connectionId: binding.connectionId,
            organizationId: binding.organizationId,
            workspaceId: binding.workspaceId,
            accountId: binding.accountId,
            scopeType: binding.scopeType,
            selector: binding.selector,
            enabled: binding.enabled,
            createdAt: binding.createdAt,
            updatedAt: binding.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.sourceAuthBindingsTable.id,
            set: {
              sourceId: binding.sourceId,
              connectionId: binding.connectionId,
              organizationId: binding.organizationId,
              workspaceId: binding.workspaceId,
              accountId: binding.accountId,
              scopeType: binding.scopeType,
              selector: binding.selector,
              enabled: binding.enabled,
              createdAt: binding.createdAt,
              updatedAt: binding.updatedAt,
            },
          });
      });
    });
  };

  const removeSourceAuthBindingRowById = async (
    bindingId: SourceAuthBinding["id"],
  ): Promise<boolean> =>
    writeLocked(async () =>
      adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const existing = await transactionContext.db
          .select({ id: transactionContext.tables.sourceAuthBindingsTable.id })
          .from(transactionContext.tables.sourceAuthBindingsTable)
          .where(eq(transactionContext.tables.sourceAuthBindingsTable.id, bindingId))
          .limit(1);

        if (existing.length === 0) {
          return false;
        }

        await transactionContext.db
          .delete(transactionContext.tables.sourceAuthBindingsTable)
          .where(eq(transactionContext.tables.sourceAuthBindingsTable.id, bindingId));

        return true;
      })
    );

  const listAuthMaterialRows = async (): Promise<Array<AuthMaterial>> => {
    const rows = await db.select().from(tables.authMaterialsTable).orderBy(
      asc(tables.authMaterialsTable.updatedAt),
      asc(tables.authMaterialsTable.id),
    );

    return rows.map(toAuthMaterial);
  };

  const upsertAuthMaterialRow = async (material: AuthMaterial): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.authMaterialsTable)
          .values({
            id: material.id,
            connectionId: material.connectionId,
            ciphertext: material.ciphertext,
            keyVersion: material.keyVersion,
            createdAt: material.createdAt,
            updatedAt: material.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.authMaterialsTable.id,
            set: {
              connectionId: material.connectionId,
              ciphertext: material.ciphertext,
              keyVersion: material.keyVersion,
              createdAt: material.createdAt,
              updatedAt: material.updatedAt,
            },
          });
      });
    });
  };

  const removeAuthMaterialRowsByConnectionId = async (
    connectionId: AuthMaterial["connectionId"],
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        await transactionContext.db
          .delete(transactionContext.tables.authMaterialsTable)
          .where(eq(transactionContext.tables.authMaterialsTable.connectionId, connectionId));
      });
    });
  };

  const listOAuthStateRows = async (): Promise<Array<OAuthState>> => {
    const rows = await db.select().from(tables.oauthStatesTable).orderBy(
      asc(tables.oauthStatesTable.updatedAt),
      asc(tables.oauthStatesTable.id),
    );

    return rows.map(toOAuthState);
  };

  const upsertOAuthStateRow = async (state: OAuthState): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);

        await transactionContext.db
          .insert(transactionContext.tables.oauthStatesTable)
          .values({
            id: state.id,
            connectionId: state.connectionId,
            accessTokenCiphertext: state.accessTokenCiphertext,
            refreshTokenCiphertext: state.refreshTokenCiphertext,
            keyVersion: state.keyVersion,
            expiresAt: state.expiresAt,
            scope: state.scope,
            tokenType: state.tokenType,
            issuer: state.issuer,
            refreshConfigJson: state.refreshConfigJson,
            tokenVersion: state.tokenVersion,
            leaseHolder: state.leaseHolder,
            leaseExpiresAt: state.leaseExpiresAt,
            leaseFence: state.leaseFence,
            lastRefreshAt: state.lastRefreshAt,
            lastRefreshErrorClass: state.lastRefreshErrorClass,
            lastRefreshError: state.lastRefreshError,
            reauthRequiredAt: state.reauthRequiredAt,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.oauthStatesTable.id,
            set: {
              connectionId: state.connectionId,
              accessTokenCiphertext: state.accessTokenCiphertext,
              refreshTokenCiphertext: state.refreshTokenCiphertext,
              keyVersion: state.keyVersion,
              expiresAt: state.expiresAt,
              scope: state.scope,
              tokenType: state.tokenType,
              issuer: state.issuer,
              refreshConfigJson: state.refreshConfigJson,
              tokenVersion: state.tokenVersion,
              leaseHolder: state.leaseHolder,
              leaseExpiresAt: state.leaseExpiresAt,
              leaseFence: state.leaseFence,
              lastRefreshAt: state.lastRefreshAt,
              lastRefreshErrorClass: state.lastRefreshErrorClass,
              lastRefreshError: state.lastRefreshError,
              reauthRequiredAt: state.reauthRequiredAt,
              createdAt: state.createdAt,
              updatedAt: state.updatedAt,
            },
          });
      });
    });
  };

  const removeOAuthStateRowsByConnectionId = async (
    connectionId: OAuthState["connectionId"],
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        await transactionContext.db
          .delete(transactionContext.tables.oauthStatesTable)
          .where(eq(transactionContext.tables.oauthStatesTable.connectionId, connectionId));
      });
    });
  };

  return {
    listAuthConnectionRows,
    upsertAuthConnectionRow,
    removeAuthConnectionRowById,
    listSourceAuthBindingRows,
    upsertSourceAuthBindingRow,
    removeSourceAuthBindingRowById,
    listAuthMaterialRows,
    upsertAuthMaterialRow,
    removeAuthMaterialRowsByConnectionId,
    listOAuthStateRows,
    upsertOAuthStateRow,
    removeOAuthStateRowsByConnectionId,
  };
};
