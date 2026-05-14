import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { Scope, ScopeId, collectTables, createExecutor, type AnyPlugin } from "@executor-js/sdk";
import { createPgliteFumaDb } from "@executor-js/sdk/pglite";
import { loadPluginsFromJsonc } from "@executor-js/config";

import executorConfig from "../../executor.config";
import { importSqliteDataToFuma } from "./sqlite-import";

interface ResolvedStorage {
  readonly dataDir: string;
  readonly pgliteDir: string;
  readonly sqlitePath: string;
  readonly importMarkerPath: string;
}

const resolveStorage = (): ResolvedStorage => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    pgliteDir: join(dataDir, "pglite"),
    sqlitePath: join(dataDir, "data.db"),
    importMarkerPath: join(dataDir, "pglite-sqlite-imported"),
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
  readonly operation: "createPglite" | "importSqlite";
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

const createLocalExecutorLayer = () => {
  const storage = resolveStorage();

  return Layer.effect(LocalExecutorTag)(
    Effect.gen(function* () {
      const { cwd, plugins } = yield* loadLocalPlugins;
      const scopeId = makeScopeId(cwd);
      const tables = collectTables(plugins);

      const pglite = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createPgliteFumaDb({
              tables,
              namespace: "executor_local",
              dataDir: storage.pgliteDir,
            }),
          catch: (cause) => new LocalExecutorCreateError({ operation: "createPglite", cause }),
        }),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      const importResult = yield* Effect.tryPromise({
        try: () =>
          importSqliteDataToFuma({
            sqlitePath: storage.sqlitePath,
            markerPath: storage.importMarkerPath,
            db: pglite.db,
            tables,
            scopeId,
          }),
        catch: (cause) => new LocalExecutorCreateError({ operation: "importSqlite", cause }),
      });

      if (importResult.imported) {
        console.warn(
          `[executor] Imported ${importResult.importedRows} row(s) from SQLite into PGlite` +
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
        db: pglite.db,
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
