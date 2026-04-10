import { Effect, Layer, ManagedRuntime, Context } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as SqlClient from "@effect/sql/SqlClient";
import { NodeFileSystem } from "@effect/platform-node";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createExecutor, scopeKv } from "@executor/sdk";
import {
  makeSqliteKv,
  makeKvConfig,
  makeScopedKv,
  migrate,
} from "@executor/storage-file";
import {
  openApiPlugin,
  makeKvOperationStore,
  withConfigFile as withOpenApiConfigFile,
} from "@executor/plugin-openapi";
import {
  mcpPlugin,
  makeKvBindingStore,
  withConfigFile as withMcpConfigFile,
} from "@executor/plugin-mcp";
import {
  googleDiscoveryPlugin,
  makeKvBindingStore as makeKvGoogleDiscoveryBindingStore,
} from "@executor/plugin-google-discovery";
import {
  graphqlPlugin,
  makeKvOperationStore as makeKvGraphqlOperationStore,
  withConfigFile as withGraphqlConfigFile,
} from "@executor/plugin-graphql";
import { keychainPlugin } from "@executor/plugin-keychain";
import { fileSecretsPlugin } from "@executor/plugin-file-secrets";
import { onepasswordPlugin } from "@executor/plugin-onepassword";

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const resolveDbPath = (): string => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return `${dataDir}/data.db`;
};

// ---------------------------------------------------------------------------
// Local plugins — defined once, used for both the layer and type inference
// ---------------------------------------------------------------------------

const createLocalPlugins = (
  scopedKv: ReturnType<typeof makeScopedKv>,
  configPath: string,
  fsLayer: typeof NodeFileSystem.layer,
) =>
  [
    openApiPlugin({
      operationStore: withOpenApiConfigFile(
        makeKvOperationStore(scopedKv, "openapi"),
        configPath,
        fsLayer,
      ),
    }),
    mcpPlugin({
      bindingStore: withMcpConfigFile(
        makeKvBindingStore(scopedKv, "mcp"),
        configPath,
        fsLayer,
      ),
    }),
    googleDiscoveryPlugin({
      bindingStore: makeKvGoogleDiscoveryBindingStore(
        scopedKv,
        "google-discovery",
      ),
    }),
    graphqlPlugin({
      operationStore: withGraphqlConfigFile(
        makeKvGraphqlOperationStore(scopedKv, "graphql"),
        configPath,
        fsLayer,
      ),
    }),
    keychainPlugin(),
    fileSecretsPlugin(),
    onepasswordPlugin({
      kv: scopeKv(scopedKv, "onepassword"),
    }),
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
// Layer — SQLite-backed, keeps connection alive via ManagedRuntime
// ---------------------------------------------------------------------------

const createLocalExecutorLayer = () => {
  const dbPath = resolveDbPath();

  return Layer.effect(
    LocalExecutorTag,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));

      const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
      const kv = makeSqliteKv(sql);
      const config = makeKvConfig(kv, { cwd });
      const scopedKv = makeScopedKv(kv, cwd);
      const configPath = join(cwd, "executor.jsonc");
      const fsLayer = NodeFileSystem.layer;

      return yield* createExecutor({
        ...config,
        plugins: createLocalPlugins(scopedKv, configPath, fsLayer),
      });
    }),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: dbPath })));
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

export const getExecutor = () =>
  loadSharedHandle().then((handle) => handle.executor);

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
