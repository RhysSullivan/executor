import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  createControlPlaneRows,
  type SqlControlPlaneRows,
} from "./control-plane-rows";
import {
  createDrizzleContext,
  createSqlRuntime,
  type CreateSqlRuntimeOptions,
  type SqlBackend,
} from "./sql-runtime";

export { tableNames, type DrizzleTables } from "./schema";
export {
  ControlPlanePersistenceError,
  toPersistenceError,
} from "./persistence-errors";
export {
  createSqlRuntime,
  createDrizzleContext,
  ensureSchema,
  type SqlRuntime,
  type SqlBackend,
  type CreateSqlRuntimeOptions,
} from "./sql-runtime";
export {
  createControlPlaneRows,
  type SqlControlPlaneRows,
} from "./control-plane-rows";

export type SqlControlPlanePersistence = {
  backend: SqlBackend;
  db: any;
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
      const drizzleContext = createDrizzleContext(runtime.db);
      const rows = createControlPlaneRows({
        backend: runtime.backend,
        db: drizzleContext.db,
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
