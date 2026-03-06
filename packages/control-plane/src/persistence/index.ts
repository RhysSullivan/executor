import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  createControlPlaneRows,
  type SqlControlPlaneRows,
} from "./control-plane-rows";
import { createDrizzleClient } from "./client";
import {
  createDrizzleContext,
  createSqlRuntime,
  runMigrations,
  type CreateSqlRuntimeOptions,
  type DrizzleDb,
  type SqlBackend,
} from "./sql-runtime";

export { tableNames, type DrizzleTables } from "./schema";
export {
  ControlPlanePersistenceError,
  toPersistenceError,
  type PersistenceErrorKind,
} from "./persistence-errors";
export { createDrizzleClient, type DrizzleClient } from "./client";
export {
  createSqlRuntime,
  createDrizzleContext,
  runMigrations,
  type SqlRuntime,
  type SqlBackend,
  type DrizzleDb,
  type CreateSqlRuntimeOptions,
} from "./sql-runtime";
export {
  createControlPlaneRows,
  type SqlControlPlaneRows,
} from "./control-plane-rows";

export type SqlControlPlanePersistence = {
  backend: SqlBackend;
  db: DrizzleDb;
  rows: SqlControlPlaneRows;
  close: () => Promise<void>;
};

export class SqlPersistenceBootstrapError extends Data.TaggedError(
  "SqlPersistenceBootstrapError",
)<{
  message: string;
  details: string | null;
}> {}

export const makeSqlControlPlanePersistence = (
  options: CreateSqlRuntimeOptions,
): Effect.Effect<SqlControlPlanePersistence, SqlPersistenceBootstrapError> =>
  Effect.tryPromise({
    try: async () => {
      const runtime = await createSqlRuntime(options);
      await runMigrations(runtime, { migrationsFolder: options.migrationsFolder });
      const drizzleContext = createDrizzleContext(runtime.db);
      const client = createDrizzleClient({
        backend: runtime.backend,
        db: drizzleContext.db,
      });
      const rows = createControlPlaneRows({
        client,
        tables: drizzleContext.tables,
      });

      return {
        backend: runtime.backend,
        db: runtime.db,
        rows,
        close: () => runtime.close(),
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
