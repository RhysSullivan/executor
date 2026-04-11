import { Effect, Layer, ManagedRuntime, Context } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createExecutor, ScopeId, type Scope } from "@executor/sdk";
import { composeExecutorSchema } from "@executor/storage";
import { makeFileSqliteStorage } from "@executor/storage-sqlite/bun";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { googleDiscoveryPlugin } from "@executor/plugin-google-discovery";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { keychainPlugin } from "@executor/plugin-keychain";
import { fileSecretsPlugin } from "@executor/plugin-file-secrets";
import { onepasswordPlugin } from "@executor/plugin-onepassword";

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const resolveDbPath = (): string => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "data.db");
};

/**
 * The previous release used a KV-shaped SQLite schema (single `kv`
 * table). The new relational schema cannot read those rows. On first
 * launch with the new adapter we detect the legacy shape and move the
 * file aside so the new adapter starts from an empty database.
 *
 * Detection opens the file read-only via `bun:sqlite` (the same driver
 * the new adapter uses here) and probes `sqlite_master` for a `kv`
 * table. If the probe succeeds and the table exists, we rename the
 * file to `data.db.legacy-<timestamp>`.
 */
const backupLegacyDatabase = async (dbPath: string): Promise<void> => {
  if (!fs.existsSync(dbPath)) return;

  try {
    const header = Buffer.alloc(16);
    const handle = fs.openSync(dbPath, "r");
    try {
      fs.readSync(handle, header, 0, 16, 0);
    } finally {
      fs.closeSync(handle);
    }
    const isSqlite = header.toString("ascii", 0, 15) === "SQLite format 3";
    if (!isSqlite) return;
  } catch {
    return;
  }

  let hasLegacyShape = false;
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("kv");
      hasLegacyShape = Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return;
  }

  if (!hasLegacyShape) return;

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.legacy-${suffix}`;
  fs.renameSync(dbPath, backupPath);
  // eslint-disable-next-line no-console
  console.log(`[executor] Detected legacy KV database. Backed up to ${backupPath}`);
};

/**
 * Derive a URL-safe scope ID from a folder path.
 * Format: `foldername-shortHash` e.g. `my-project-a1b2c3d4`
 */
const makeScopeId = (cwd: string): string => {
  const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

// ---------------------------------------------------------------------------
// Local plugins — defined once, used for both the layer and type inference
// ---------------------------------------------------------------------------

const createLocalPlugins = (configPath: string, fsLayer: typeof NodeFileSystem.layer) =>
  [
    openApiPlugin({ configFile: { path: configPath, fsLayer } }),
    mcpPlugin({ configFile: { path: configPath, fsLayer } }),
    googleDiscoveryPlugin(),
    graphqlPlugin({ configFile: { path: configPath, fsLayer } }),
    keychainPlugin(),
    fileSecretsPlugin(),
    onepasswordPlugin(),
  ] as const;

// Full typed executor — inferred from plugin list
type LocalPlugins = ReturnType<typeof createLocalPlugins>;

// Private tag preserving the full plugin type
class LocalExecutorTag extends Context.Tag("@executor/local/Executor")<
  LocalExecutorTag,
  Effect.Effect.Success<ReturnType<typeof createExecutor<LocalPlugins>>>
>() {}

export type LocalExecutor = Context.Tag.Service<typeof LocalExecutorTag>;

// ---------------------------------------------------------------------------
// Layer — SQLite-backed via better-sqlite3 (Node compatible)
// ---------------------------------------------------------------------------

const LOCAL_ENCRYPTION_KEY =
  process.env.EXECUTOR_ENCRYPTION_KEY ?? "executor-local-default-encryption-key";

const createLocalExecutorLayer = () => {
  const dbPath = resolveDbPath();

  return Layer.effect(
    LocalExecutorTag,
    Effect.gen(function* () {
      yield* Effect.promise(() => backupLegacyDatabase(dbPath));
      const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
      const configPath = join(cwd, "executor.jsonc");
      const fsLayer = NodeFileSystem.layer;

      const plugins = createLocalPlugins(configPath, fsLayer);
      const schema = composeExecutorSchema({ plugins });

      const storage = yield* makeFileSqliteStorage({ filename: dbPath, schema });

      const scope: Scope = {
        id: ScopeId.make(makeScopeId(cwd)),
        name: cwd,
        createdAt: new Date(),
      };

      return yield* createExecutor({
        scope,
        storage,
        plugins,
        encryptionKey: LOCAL_ENCRYPTION_KEY,
      });
    }),
  );
};

// ---------------------------------------------------------------------------
// Handle — keeps runtime alive, returns fully typed executor
// ---------------------------------------------------------------------------

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
