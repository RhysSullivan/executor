import {
  type RowStoreError,
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as path from "node:path";

import { createRowOperations } from "./row-operations";
import { createRowsEffectApi } from "./rows-effect-api";
import {
  createDrizzleContext,
  createPostgresAdapter,
  createSqliteAdapter,
  runMigrations,
  type SqlBackend,
} from "./sql-internals";
import { createSourceAndArtifactStores } from "./source-artifact-stores";

export type SqlControlPlanePersistenceOptions = {
  databaseUrl?: string;
  sqlitePath?: string;
  postgresApplicationName?: string;
};

export type SqlControlPlanePersistence = {
  backend: SqlBackend;
  sourceStore: SourceStore;
  toolArtifactStore: ToolArtifactStore;
  rows: {
    profile: {
      get: () => Effect.Effect<Option.Option<Profile>, RowStoreError>;
      upsert: (profile: Profile) => Effect.Effect<void, RowStoreError>;
    };
    organizations: {
      list: () => Effect.Effect<ReadonlyArray<Organization>, RowStoreError>;
      upsert: (organization: Organization) => Effect.Effect<void, RowStoreError>;
    };
    organizationMemberships: {
      list: () => Effect.Effect<ReadonlyArray<OrganizationMembership>, RowStoreError>;
      upsert: (
        membership: OrganizationMembership,
      ) => Effect.Effect<void, RowStoreError>;
    };
    workspaces: {
      list: () => Effect.Effect<ReadonlyArray<Workspace>, RowStoreError>;
      upsert: (workspace: Workspace) => Effect.Effect<void, RowStoreError>;
    };
    authConnections: {
      list: () => Effect.Effect<ReadonlyArray<AuthConnection>, RowStoreError>;
      upsert: (connection: AuthConnection) => Effect.Effect<void, RowStoreError>;
      removeById: (
        connectionId: AuthConnection["id"],
      ) => Effect.Effect<boolean, RowStoreError>;
    };
    sourceAuthBindings: {
      list: () => Effect.Effect<ReadonlyArray<SourceAuthBinding>, RowStoreError>;
      upsert: (binding: SourceAuthBinding) => Effect.Effect<void, RowStoreError>;
      removeById: (
        bindingId: SourceAuthBinding["id"],
      ) => Effect.Effect<boolean, RowStoreError>;
    };
    authMaterials: {
      list: () => Effect.Effect<ReadonlyArray<AuthMaterial>, RowStoreError>;
      upsert: (material: AuthMaterial) => Effect.Effect<void, RowStoreError>;
      removeByConnectionId: (
        connectionId: AuthMaterial["connectionId"],
      ) => Effect.Effect<void, RowStoreError>;
    };
    oauthStates: {
      list: () => Effect.Effect<ReadonlyArray<OAuthState>, RowStoreError>;
      upsert: (state: OAuthState) => Effect.Effect<void, RowStoreError>;
      removeByConnectionId: (
        connectionId: OAuthState["connectionId"],
      ) => Effect.Effect<void, RowStoreError>;
    };
    storageInstances: {
      list: () => Effect.Effect<ReadonlyArray<StorageInstance>, RowStoreError>;
      upsert: (instance: StorageInstance) => Effect.Effect<void, RowStoreError>;
      removeById: (
        storageInstanceId: StorageInstance["id"],
      ) => Effect.Effect<boolean, RowStoreError>;
    };
    policies: {
      list: () => Effect.Effect<ReadonlyArray<Policy>, RowStoreError>;
      upsert: (policy: Policy) => Effect.Effect<void, RowStoreError>;
      removeById: (
        policyId: Policy["id"],
      ) => Effect.Effect<boolean, RowStoreError>;
    };
    approvals: {
      list: () => Effect.Effect<ReadonlyArray<Approval>, RowStoreError>;
      upsert: (approval: Approval) => Effect.Effect<void, RowStoreError>;
    };
  };
  close: () => Promise<void>;
};

class SqlPersistenceBootstrapError extends Data.TaggedError(
  "SqlPersistenceBootstrapError",
)<{
  message: string;
  details: string | null;
}> {}

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const withWriteLock = <A>(
  queueRef: { current: Promise<void> },
  run: () => Promise<A>,
): Promise<A> => {
  const next = queueRef.current.then(run, run);
  queueRef.current = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

export const makeSqlControlPlanePersistence = (
  options: SqlControlPlanePersistenceOptions,
): Effect.Effect<SqlControlPlanePersistence, SqlPersistenceBootstrapError> =>
  Effect.tryPromise({
    try: async () => {
      const databaseUrl = trim(options.databaseUrl);
      const sqlitePath = path.resolve(
        options.sqlitePath ?? ".executor-v2/control-plane.sqlite",
      );
      const backend: SqlBackend =
        databaseUrl && (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://"))
          ? "postgres"
          : "sqlite";

      const adapter =
        backend === "postgres"
          ? await createPostgresAdapter(databaseUrl!, trim(options.postgresApplicationName))
          : await createSqliteAdapter(sqlitePath);

      await runMigrations(backend, adapter);
      const drizzleContext = createDrizzleContext(adapter);
      const { db, tables } = drizzleContext;

      const writeQueueRef = {
        current: Promise.resolve<void>(undefined),
      };

      const {
        listOrganizationsRows,
        upsertOrganizationRow,
        listOrganizationMembershipRows,
        upsertOrganizationMembershipRow,
        listWorkspaceRows,
        upsertWorkspaceRow,
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
      } = createRowOperations({
        adapter,
        db,
        tables,
        writeLocked: <A>(run: () => Promise<A>) => withWriteLock(writeQueueRef, run),
      });

      const { sourceStore, toolArtifactStore } = createSourceAndArtifactStores({
        backend,
        adapter,
        db,
        tables,
        writeLocked: <A>(run: () => Promise<A>) => withWriteLock(writeQueueRef, run),
      });

      const rows: SqlControlPlanePersistence["rows"] = createRowsEffectApi(
        backend,
        {
          listOrganizationsRows,
          upsertOrganizationRow,
          listOrganizationMembershipRows,
          upsertOrganizationMembershipRow,
          listWorkspaceRows,
          upsertWorkspaceRow,
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
        },
      );

      return {
        backend,
        sourceStore,
        toolArtifactStore,
        rows,
        close: () => adapter.close(),
      };
    },
    catch: (cause) => {
      const details = cause instanceof Error ? cause.message : String(cause);
      return new SqlPersistenceBootstrapError({
        message: `Failed initializing SQL control-plane persistence: ${details}`,
        details,
      });
    },
  });
