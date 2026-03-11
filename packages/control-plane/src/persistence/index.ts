import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createDrizzleClient, type DrizzleClient } from "./client";
import {
  createAccountsRepo,
  createCredentialsRepo,
  createCodeMigrationsRepo,
  createExecutionInteractionsRepo,
  createExecutionsRepo,
  createLocalInstallationsRepo,
  createOrganizationMembershipsRepo,
  createOrganizationsRepo,
  createPoliciesRepo,
  createSecretMaterialsRepo,
  createSourceAuthSessionsRepo,
  createSourceOauthClientsRepo,
  createSourceRecipeDocumentsRepo,
  createSourceRecipeSchemaBundlesRepo,
  createSourceRecipeOperationsRepo,
  createSourceRecipeRevisionsRepo,
  createSourceRecipesRepo,
  createSourcesRepo,
  createWorkspacesRepo,
} from "./repos";
import { drizzleSchema, tableNames, type DrizzleTables } from "./schema";
import {
  createSqlRuntime,
  runMigrations,
  type CreateSqlRuntimeOptions,
  type DrizzleDb,
  type SqlBackend,
  type SqlRuntime,
} from "./sql-runtime";
import { runCodeMigrations } from "./code-migrations";

export { tableNames, type DrizzleTables } from "./schema";
export {
  ControlPlanePersistenceError,
  toPersistenceError,
  type PersistenceErrorKind,
} from "./persistence-errors";
export { createDrizzleClient, type DrizzleClient } from "./client";
export {
  createSqlRuntime,
  runMigrations,
  type SqlRuntime,
  type SqlBackend,
  type DrizzleDb,
  type CreateSqlRuntimeOptions,
} from "./sql-runtime";

const createRows = (client: DrizzleClient, tables: DrizzleTables = drizzleSchema) => ({
  accounts: createAccountsRepo(client, tables),
  organizations: createOrganizationsRepo(client, tables),
  organizationMemberships: createOrganizationMembershipsRepo(client, tables),
  workspaces: createWorkspacesRepo(client, tables),
  sources: createSourcesRepo(client, tables),
  sourceRecipes: createSourceRecipesRepo(client, tables),
  sourceRecipeRevisions: createSourceRecipeRevisionsRepo(client, tables),
  sourceRecipeDocuments: createSourceRecipeDocumentsRepo(client, tables),
  sourceRecipeSchemaBundles: createSourceRecipeSchemaBundlesRepo(client, tables),
  sourceRecipeOperations: createSourceRecipeOperationsRepo(client, tables),
  codeMigrations: createCodeMigrationsRepo(client, tables),
  credentials: createCredentialsRepo(client, tables),
  sourceOauthClients: createSourceOauthClientsRepo(client, tables),
  secretMaterials: createSecretMaterialsRepo(client, tables),
  sourceAuthSessions: createSourceAuthSessionsRepo(client, tables),
  policies: createPoliciesRepo(client, tables),
  localInstallations: createLocalInstallationsRepo(client, tables),
  executions: createExecutionsRepo(client, tables),
  executionInteractions: createExecutionInteractionsRepo(client, tables),
});

export type SqlControlPlaneRows = ReturnType<typeof createRows>;

export type SqlControlPlanePersistence = {
  backend: SqlBackend;
  db: DrizzleDb;
  rows: SqlControlPlaneRows;
  close: () => Promise<void>;
};

export class SqlControlPlanePersistenceService extends Context.Tag(
  "#persistence/SqlControlPlanePersistenceService",
)<SqlControlPlanePersistenceService, SqlControlPlanePersistence>() {}

export class SqlControlPlaneRowsService extends Context.Tag(
  "#persistence/SqlControlPlaneRowsService",
)<SqlControlPlaneRowsService, SqlControlPlaneRows>() {}

export class SqlPersistenceBootstrapError extends Data.TaggedError(
  "SqlPersistenceBootstrapError",
)<{
  message: string;
  details: string | null;
}> {}

const toBootstrapError = (cause: unknown): SqlPersistenceBootstrapError => {
  const details = cause instanceof Error ? cause.message : String(cause);
  return new SqlPersistenceBootstrapError({
    message: `Failed initializing SQL control-plane persistence: ${details}`,
    details,
  });
};

const createRuntimeEffect = (options: CreateSqlRuntimeOptions) =>
  Effect.tryPromise({
    try: () => createSqlRuntime(options),
    catch: toBootstrapError,
  });

const runMigrationsEffect = (
  runtime: SqlRuntime,
  migrationsFolder: string | undefined,
) =>
  Effect.tryPromise({
    try: () => runMigrations(runtime, { migrationsFolder }),
    catch: toBootstrapError,
  });

const closeRuntimeEffect = (runtime: SqlRuntime) =>
  Effect.tryPromise({
    try: () => runtime.close(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause ?? "unknown close error")),
  }).pipe(Effect.orDie);

export type CreateSqlControlPlanePersistenceOptions =
  & CreateSqlRuntimeOptions
  & {
    runCodeMigrations?: boolean;
  };

export const createSqlControlPlanePersistence = (
  options: CreateSqlControlPlanePersistenceOptions,
): Effect.Effect<SqlControlPlanePersistence, SqlPersistenceBootstrapError> =>
  Effect.flatMap(createRuntimeEffect(options), (runtime) =>
    runMigrationsEffect(runtime, options.migrationsFolder).pipe(
      Effect.map(() => {
        const client = createDrizzleClient({
          backend: runtime.backend,
          db: runtime.db,
        });
        const rows = createRows(client);

        return {
          backend: runtime.backend,
          db: runtime.db,
          rows,
          close: () => runtime.close(),
        } satisfies SqlControlPlanePersistence;
      }),
      Effect.flatMap((persistence) =>
        options.runCodeMigrations === false
          ? Effect.succeed(persistence)
          : runCodeMigrations(persistence.rows).pipe(
              Effect.mapError(toBootstrapError),
              Effect.map(() => persistence),
            )),
      Effect.catchAll((error) =>
        closeRuntimeEffect(runtime).pipe(
          Effect.zipRight(Effect.fail(error)),
        )),
    ));

export const SqlControlPlanePersistenceLive = (
  options: CreateSqlControlPlanePersistenceOptions,
) =>
  Layer.scoped(
    SqlControlPlanePersistenceService,
    Effect.acquireRelease(
      createSqlControlPlanePersistence(options),
      (persistence) =>
        Effect.tryPromise({
          try: () => persistence.close(),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause ?? "unknown close error")),
        }).pipe(Effect.orDie),
    ),
  );

export const SqlControlPlaneRowsLive = Layer.effect(
  SqlControlPlaneRowsService,
  Effect.map(SqlControlPlanePersistenceService, (persistence) => persistence.rows),
);
