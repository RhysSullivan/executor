import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { Scope, ScopeId, collectTables, createExecutor, type AnyPlugin } from "@executor-js/sdk";
import { loadPluginsFromJsonc } from "@executor-js/config";

import executorConfig from "../../executor.config";
import { importSqliteDataToFuma } from "./sqlite-import";
import { createSqliteFumaDb } from "./sqlite-fumadb";

interface ResolvedStorage {
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly importMarkerPath: string;
}

const localNamespace = "executor_local";

const resolveStorage = (): ResolvedStorage => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    sqlitePath: join(dataDir, "data.db"),
    importMarkerPath: join(dataDir, "fumadb-sqlite-imported"),
  };
};

// Hash suffix disambiguates same-basename folders so two projects with
// identical directory names cannot collide on the same scope id.
const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const resolvePluginConfigPath = (scopeDir: string): string => join(scopeDir, "executor.jsonc");

// Plugins reach the host through two doors that compose:
//   - `executor.config.ts`'s static tuple
//   - `executor.jsonc#plugins` loaded at boot
// Static config wins on conflict, matching the Vite plugin.
type LocalPlugins = readonly AnyPlugin[];

const loadLocalPlugins = Effect.gen(function* () {
  const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
  const staticPlugins = executorConfig.plugins();
  const dynamicPlugins =
    (yield* Effect.promise(() => loadPluginsFromJsonc({ path: resolvePluginConfigPath(cwd) }))) ??
    [];

  const staticPackageNames = new Set(
    staticPlugins.map((plugin) => plugin.packageName).filter((name): name is string => !!name),
  );
  const dedupedDynamic = dynamicPlugins.filter((plugin) => {
    if (plugin.packageName && staticPackageNames.has(plugin.packageName)) {
      console.warn(
        `[executor] plugin "${plugin.packageName}" appears in both ` +
          `executor.config.ts and executor.jsonc#plugins. The static ` +
          `entry wins; the jsonc entry is ignored.`,
      );
      return false;
    }
    return true;
  });

  return {
    cwd,
    plugins: [...staticPlugins, ...dedupedDynamic] as LocalPlugins,
  };
});

interface LocalExecutorBundle {
  readonly executor: Effect.Success<ReturnType<typeof createExecutor<LocalPlugins>>>;
  readonly plugins: LocalPlugins;
}

class LocalExecutorTag extends Context.Service<LocalExecutorTag, LocalExecutorBundle>()(
  "@executor-js/local/Executor",
) {}

export type LocalExecutor = LocalExecutorBundle["executor"];

class LocalExecutorCreateError extends Data.TaggedError("LocalExecutorCreateError")<{
  readonly operation: "createSqlite" | "importSqlite";
  readonly cause: unknown;
}> {}

class LocalExecutorDisposeError extends Data.TaggedError("LocalExecutorDisposeError")<{
  readonly operation: "createHandle" | "disposeExecutor" | "disposeRuntime";
  readonly cause: unknown;
}> {}

const ignorePromiseFailure = (
  operation: LocalExecutorDisposeError["operation"],
  try_: () => Promise<unknown>,
) =>
  Effect.runPromise(
    Effect.ignore(
      Effect.tryPromise({
        try: try_,
        catch: (cause) => new LocalExecutorDisposeError({ operation, cause }),
      }),
    ),
  );

const handleOrNull = (promise: ReturnType<typeof createExecutorHandle>) =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => promise,
      catch: (cause) => new LocalExecutorDisposeError({ operation: "createHandle", cause }),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed<Awaited<ReturnType<typeof createExecutorHandle>> | null>(null),
      ),
    ),
  );

const sqliteTableHasColumn = (db: Database, table: string, column: string): boolean =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info('${table.replaceAll("'", "''")}')`)
    .all()
    .some((row) => row.name === column);

const isFumaSqliteDatabase = (path: string): boolean => {
  if (!fs.existsSync(path)) return false;

  let db: Database | null = null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: native SQLite probe treats unreadable legacy files as non-FumaDB databases
  try {
    db = new Database(path, { readonly: true });
    const settings = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(`private_${localNamespace}_settings`);
    return settings !== null || sqliteTableHasColumn(db, "source", "row_id");
  } catch {
    return false;
  } finally {
    db?.close();
  }
};

const removeSqliteFileSet = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${path}${suffix}`, { force: true });
  }
};

const moveSqliteFileSet = (source: string, target: string) => {
  fs.renameSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${source}${suffix}`)) {
      fs.renameSync(`${source}${suffix}`, `${target}${suffix}`);
    }
  }
};

const importLegacySqliteIfNeeded = async (options: {
  readonly storage: ResolvedStorage;
  readonly tables: ReturnType<typeof collectTables>;
  readonly scopeId: string;
}) => {
  const { storage, tables, scopeId } = options;
  if (
    !fs.existsSync(storage.sqlitePath) ||
    fs.existsSync(storage.importMarkerPath) ||
    isFumaSqliteDatabase(storage.sqlitePath)
  ) {
    return { imported: false, importedRows: 0, importedTables: [] };
  }

  const targetPath = `${storage.sqlitePath}.fumadb-next-${process.pid}-${Date.now()}`;
  removeSqliteFileSet(targetPath);

  const target = await createSqliteFumaDb({
    tables,
    namespace: localNamespace,
    path: targetPath,
  });

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local SQLite cutover must close and remove the temporary target database on import failure
  try {
    const result = await importSqliteDataToFuma({
      sqlitePath: storage.sqlitePath,
      markerPath: storage.importMarkerPath,
      db: target.db,
      tables,
      scopeId,
    });
    target.sqlite.exec("PRAGMA wal_checkpoint(FULL)");
    await target.close();

    if (result.imported) {
      moveSqliteFileSet(targetPath, storage.sqlitePath);
    } else {
      removeSqliteFileSet(targetPath);
    }
    return result;
  } catch (cause) {
    await target.close();
    removeSqliteFileSet(targetPath);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve the original import failure after temp-file cleanup
    throw cause;
  }
};

const createLocalExecutorLayer = () => {
  const storage = resolveStorage();

  return Layer.effect(LocalExecutorTag)(
    Effect.gen(function* () {
      const { cwd, plugins } = yield* loadLocalPlugins;
      const scopeId = makeScopeId(cwd);
      const tables = collectTables(plugins);

      const importResult = yield* Effect.tryPromise({
        try: () =>
          importLegacySqliteIfNeeded({
            storage,
            tables,
            scopeId,
          }),
        catch: (cause) => new LocalExecutorCreateError({ operation: "importSqlite", cause }),
      });

      const sqlite = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createSqliteFumaDb({
              tables,
              namespace: localNamespace,
              path: storage.sqlitePath,
            }),
          catch: (cause) => new LocalExecutorCreateError({ operation: "createSqlite", cause }),
        }),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      if (importResult.imported) {
        console.warn(
          `[executor] Imported ${importResult.importedRows} row(s) into FumaDB SQLite storage` +
            (importResult.backupPath ? `; moved old DB to ${importResult.backupPath}.` : "."),
        );
      }

      const scope = Scope.make({
        id: ScopeId.make(scopeId),
        name: cwd,
        createdAt: new Date(),
      });

      const executor = yield* createExecutor({
        scopes: [scope],
        db: sqlite.db,
        plugins,
        onElicitation: "accept-all",
        oauthEndpointUrlPolicy: { allowHttp: true },
      });

      return { executor, plugins };
    }),
  );
};

export const createExecutorHandle = async () => {
  const layer = createLocalExecutorLayer();
  const runtime = ManagedRuntime.make(layer);
  const bundle = await runtime.runPromise(LocalExecutorTag.asEffect());

  return {
    executor: bundle.executor,
    plugins: bundle.plugins,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(bundle.executor.close()));
      await ignorePromiseFailure("disposeRuntime", () => runtime.dispose());
    },
  };
};

export type ExecutorHandle = Awaited<ReturnType<typeof createExecutorHandle>>;

let sharedHandlePromise: ReturnType<typeof createExecutorHandle> | null = null;

const loadSharedHandle = () => {
  if (!sharedHandlePromise) {
    sharedHandlePromise = createExecutorHandle();
  }
  return sharedHandlePromise;
};

export const getExecutor = () => loadSharedHandle().then((handle) => handle.executor);
export const getExecutorBundle = () => loadSharedHandle();

export const disposeExecutor = async (): Promise<void> => {
  const currentHandlePromise = sharedHandlePromise;
  sharedHandlePromise = null;

  const handle = currentHandlePromise ? await handleOrNull(currentHandlePromise) : null;
  if (handle) {
    await ignorePromiseFailure("disposeExecutor", () => handle.dispose());
  }
};

export const reloadExecutor = () => {
  disposeExecutor();
  return getExecutor();
};
