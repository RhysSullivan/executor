import {
  type AuthConnection,
  type AuthMaterial,
  type OAuthState,
  type SourceAuthBinding,
} from "@executor-v2/schema";
import { asc, eq } from "drizzle-orm";

import {
  AuthConnectionJson,
  AuthMaterialJson,
  OAuthStateJson,
  SourceAuthBindingJson,
} from "./persistence-codecs";
import { createDrizzleContext, type DrizzleDb, type DrizzleTables, type SqlAdapter } from "./sql-internals";

type WriteLocked = <A>(run: () => Promise<A>) => Promise<A>;

type AuthOperationsInput = {
  adapter: SqlAdapter;
  db: DrizzleDb;
  tables: DrizzleTables;
  writeLocked: WriteLocked;
};

export const createAuthRowOperations = ({
  adapter,
  db,
  tables,
  writeLocked,
}: AuthOperationsInput) => {
  const listAuthConnectionRows = async (): Promise<Array<AuthConnection>> => {
    const rows = await db
      .select({ payloadJson: tables.authConnectionsTable.payloadJson })
      .from(tables.authConnectionsTable)
      .orderBy(asc(tables.authConnectionsTable.updatedAt), asc(tables.authConnectionsTable.id));

    return rows.map((row) => AuthConnectionJson.decode(row.payloadJson));
  };

  const upsertAuthConnectionRow = async (connection: AuthConnection): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = AuthConnectionJson.encode(connection);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.authConnectionsTable)
          .values({
            id: connection.id,
            workspaceId: connection.workspaceId,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.authConnectionsTable.id,
            set: {
              workspaceId: connection.workspaceId,
              payloadJson,
              updatedAt: now,
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
    const rows = await db
      .select({ payloadJson: tables.sourceAuthBindingsTable.payloadJson })
      .from(tables.sourceAuthBindingsTable)
      .orderBy(
        asc(tables.sourceAuthBindingsTable.updatedAt),
        asc(tables.sourceAuthBindingsTable.id),
      );

    return rows.map((row) => SourceAuthBindingJson.decode(row.payloadJson));
  };

  const upsertSourceAuthBindingRow = async (
    binding: SourceAuthBinding,
  ): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = SourceAuthBindingJson.encode(binding);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.sourceAuthBindingsTable)
          .values({
            id: binding.id,
            workspaceId: binding.workspaceId,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.sourceAuthBindingsTable.id,
            set: {
              workspaceId: binding.workspaceId,
              payloadJson,
              updatedAt: now,
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
    const rows = await db
      .select({ payloadJson: tables.authMaterialsTable.payloadJson })
      .from(tables.authMaterialsTable)
      .orderBy(asc(tables.authMaterialsTable.updatedAt), asc(tables.authMaterialsTable.id));

    return rows.map((row) => AuthMaterialJson.decode(row.payloadJson));
  };

  const upsertAuthMaterialRow = async (material: AuthMaterial): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = AuthMaterialJson.encode(material);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.authMaterialsTable)
          .values({
            id: material.id,
            workspaceId: null,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.authMaterialsTable.id,
            set: {
              workspaceId: null,
              payloadJson,
              updatedAt: now,
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
        const existing = await transactionContext.db
          .select({
            id: transactionContext.tables.authMaterialsTable.id,
            payloadJson: transactionContext.tables.authMaterialsTable.payloadJson,
          })
          .from(transactionContext.tables.authMaterialsTable);

        for (const row of existing) {
          const material = AuthMaterialJson.decode(row.payloadJson);
          if (material.connectionId !== connectionId) {
            continue;
          }

          await transactionContext.db
            .delete(transactionContext.tables.authMaterialsTable)
            .where(eq(transactionContext.tables.authMaterialsTable.id, row.id));
        }
      });
    });
  };

  const listOAuthStateRows = async (): Promise<Array<OAuthState>> => {
    const rows = await db
      .select({ payloadJson: tables.oauthStatesTable.payloadJson })
      .from(tables.oauthStatesTable)
      .orderBy(asc(tables.oauthStatesTable.updatedAt), asc(tables.oauthStatesTable.id));

    return rows.map((row) => OAuthStateJson.decode(row.payloadJson));
  };

  const upsertOAuthStateRow = async (state: OAuthState): Promise<void> => {
    await writeLocked(async () => {
      await adapter.transaction(async (transaction) => {
        const transactionContext = createDrizzleContext(transaction);
        const payloadJson = OAuthStateJson.encode(state);
        const now = Date.now();

        await transactionContext.db
          .insert(transactionContext.tables.oauthStatesTable)
          .values({
            id: state.id,
            workspaceId: null,
            payloadJson,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: transactionContext.tables.oauthStatesTable.id,
            set: {
              workspaceId: null,
              payloadJson,
              updatedAt: now,
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
        const existing = await transactionContext.db
          .select({
            id: transactionContext.tables.oauthStatesTable.id,
            payloadJson: transactionContext.tables.oauthStatesTable.payloadJson,
          })
          .from(transactionContext.tables.oauthStatesTable);

        for (const row of existing) {
          const state = OAuthStateJson.decode(row.payloadJson);
          if (state.connectionId !== connectionId) {
            continue;
          }

          await transactionContext.db
            .delete(transactionContext.tables.oauthStatesTable)
            .where(eq(transactionContext.tables.oauthStatesTable.id, row.id));
        }
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
