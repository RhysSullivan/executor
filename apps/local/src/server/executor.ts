import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import embeddedMigrations from "./embedded-migrations.gen";
import {
  importLegacySecrets,
  moveAsidePreScopeDb,
  readLegacySecrets,
  type LegacySecret,
} from "./db-upgrade";

import {
  Scope,
  ScopeId,
  collectSchemas,
  createExecutor,
} from "@executor/sdk";
import {
  makeSqliteAdapter,
  makeSqliteBlobStore,
} from "@executor/storage-file";
import { NodeFileSystem } from "@effect/platform-node";
import { makeFileConfigSink, type ConfigFileSink } from "@executor/config";
import * as executorSchema from "./executor-schema";

import { syncFromConfig, resolveConfigPath } from "./config-sync";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { googleDiscoveryPlugin } from "@executor/plugin-google-discovery";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { keychainPlugin } from "@executor/plugin-keychain";
import { fileSecretsPlugin } from "@executor/plugin-file-secrets";
import { onepasswordPlugin } from "@executor/plugin-onepassword";

// In dev mode the drizzle folder sits next to the source tree. In a compiled
// binary the files are inlined via the build-time gen module below, and we
// extract them to a tmpdir at boot so drizzle's `migrate()` — which only
// accepts a folder path — can read them.
const resolveMigrationsFolder = (): string => {
  if (!embeddedMigrations) {
    return join(import.meta.dirname, "../../drizzle");
  }
  const dir = fs.mkdtempSync(join(tmpdir(), "executor-migrations-"));
  for (const [rel, content] of Object.entries(embeddedMigrations)) {
    const target = join(dir, rel);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
};

const MIGRATIONS_FOLDER = resolveMigrationsFolder();

interface ResolvedDb {
  readonly path: string;
  readonly legacySecrets: readonly LegacySecret[];
}

const resolveDbPath = (): ResolvedDb => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = `${dataDir}/data.db`;
  // DBs written by pre-scope-refactor versions of the CLI have a schema
  // the current drizzle migration can't be applied on top of. Before we
  // move it aside, pull the `secret` routing rows so non-enumerating
  // providers (keychain) stay reachable after the fresh DB is created.
  const legacySecrets = readLegacySecrets(dbPath);
  const backup = moveAsidePreScopeDb(dbPath);
  if (backup) {
    console.warn(
      `[executor] Pre-scope database detected; moved to ${backup}. ` +
        `Sources and tool catalogs will need to be re-added` +
        (legacySecrets.length > 0
          ? ` (${legacySecrets.length} secret routing row(s) preserved).`
          : "."),
    );
  }
  return { path: dbPath, legacySecrets };
};

// Hash suffix disambiguates same-basename folders so two projects with
// identical directory names can't collide on the same scope id.
const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const createLocalPlugins = (configFile: ConfigFileSink) =>
  [
    openApiPlugin({ configFile }),
    mcpPlugin({ dangerouslyAllowStdioMCP: true, configFile }),
    googleDiscoveryPlugin(),
    graphqlPlugin({ configFile }),
    keychainPlugin(),
    fileSecretsPlugin(),
    onepasswordPlugin(),
  ] as const;

type LocalPlugins = ReturnType<typeof createLocalPlugins>;

class LocalExecutorTag extends Context.Tag("@executor/local/Executor")<
  LocalExecutorTag,
  Effect.Effect.Success<ReturnType<typeof createExecutor<LocalPlugins>>>
>() {}

export type LocalExecutor = Context.Tag.Service<typeof LocalExecutorTag>;

const createLocalExecutorLayer = () => {
  const { path: dbPath, legacySecrets } = resolveDbPath();

  return Layer.scoped(
    LocalExecutorTag,
    Effect.gen(function* () {
      const sqlite = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(dbPath)),
        (conn) => Effect.sync(() => conn.close()),
      );
      sqlite.exec("PRAGMA journal_mode = WAL");

      const db = drizzle(sqlite, { schema: executorSchema });
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
      const scopeId = makeScopeId(cwd);
      // Reinstate pre-scope secret routing rows once migrations have
      // created the new `secret` table. INSERT OR IGNORE makes this
      // safe across reboots and on fresh installs (no-op when there's
      // nothing to import).
      if (legacySecrets.length > 0) {
        importLegacySecrets(sqlite, scopeId, legacySecrets);
      }
      const configPath = resolveConfigPath(cwd);
      const configFile = makeFileConfigSink({
        path: configPath,
        fsLayer: NodeFileSystem.layer,
      });

      const plugins = createLocalPlugins(configFile);
      const schema = collectSchemas(plugins);
      const adapter = makeSqliteAdapter({ db, schema });
      const blobs = makeSqliteBlobStore({ db });

      const scope = new Scope({
        id: ScopeId.make(scopeId),
        name: cwd,
        createdAt: new Date(),
      });

      const executor = yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });

      // Sync sources from executor.jsonc (idempotent — plugins upsert).
      // Runs after plugins are wired so sources added here round-trip
      // back through configFile — harmless because the file already
      // contains them.
      yield* syncFromConfig(executor, configPath);

      return executor;
    }),
  );
};

export const createExecutorHandle = async () => {
  const layer = createLocalExecutorLayer();
  const runtime = ManagedRuntime.make(layer);
  const executor = await runtime.runPromise(LocalExecutorTag);

  return {
    executor,
    dispose: async () => {
      await Effect.runPromise(executor.close()).catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
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

export const disposeExecutor = async (): Promise<void> => {
  const currentHandlePromise = sharedHandlePromise;
  sharedHandlePromise = null;

  const handle = await currentHandlePromise?.catch(() => null);
  await handle?.dispose().catch(() => undefined);
};

export const reloadExecutor = () => {
  disposeExecutor();
  return getExecutor();
};
