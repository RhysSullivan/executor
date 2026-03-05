import {
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import { createControlPlaneRows } from "./control-plane-rows";
import {
  createSqlRuntime,
  createDrizzleContext,
  runMigrations,
  type SqlBackend,
} from "./sql-internals";
import { createSourceAndArtifactStores } from "./source-artifact-stores";

export type SqlControlPlanePersistenceOptions = {
  databaseUrl?: string;
  localDataDir?: string;
  postgresApplicationName?: string;
};

export type SqlControlPlaneRows = ReturnType<typeof createControlPlaneRows>;

export type SqlControlPlanePersistence = {
  backend: SqlBackend;
  sourceStore: SourceStore;
  toolArtifactStore: ToolArtifactStore;
  rows: SqlControlPlaneRows;
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

export const makeSqlControlPlanePersistence = (
  options: SqlControlPlanePersistenceOptions,
): Effect.Effect<SqlControlPlanePersistence, SqlPersistenceBootstrapError> =>
  Effect.tryPromise({
    try: async () => {
      const localDataDir = path.resolve(
        options.localDataDir ?? ".executor-v2/control-plane-pgdata",
      );
      const runtime = await createSqlRuntime({
        databaseUrl: trim(options.databaseUrl),
        localDataDir,
        postgresApplicationName: trim(options.postgresApplicationName),
      });

      await runMigrations(runtime);

      const drizzleContext = createDrizzleContext(runtime.db);
      const { db, tables } = drizzleContext;

      const { sourceStore, toolArtifactStore } = createSourceAndArtifactStores({
        backend: runtime.backend,
        db,
        tables,
      });

      const rows = createControlPlaneRows({
        backend: runtime.backend,
        db,
        tables,
      });

      return {
        backend: runtime.backend,
        sourceStore,
        toolArtifactStore,
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
