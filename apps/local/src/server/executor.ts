import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
import * as executorSchema from "./executor-schema";

import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { googleDiscoveryPlugin } from "@executor/plugin-google-discovery";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { keychainPlugin } from "@executor/plugin-keychain";
import { fileSecretsPlugin } from "@executor/plugin-file-secrets";
import { onepasswordPlugin } from "@executor/plugin-onepassword";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const resolveDbPath = (): string => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return `${dataDir}/data.db`;
};

// Hash suffix disambiguates same-basename folders so two projects with
// identical directory names can't collide on the same scope id.
const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const createLocalPlugins = () =>
  [
    openApiPlugin(),
    mcpPlugin({ dangerouslyAllowStdioMCP: true }),
    googleDiscoveryPlugin(),
    graphqlPlugin(),
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
  const dbPath = resolveDbPath();

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

      const plugins = createLocalPlugins();
      const schema = collectSchemas(plugins);
      const adapter = makeSqliteAdapter({ db, schema });
      const blobs = makeSqliteBlobStore({ db });

      const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
      const scope = new Scope({
        id: ScopeId.make(makeScopeId(cwd)),
        name: cwd,
        createdAt: new Date(),
      });

      return yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });
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
