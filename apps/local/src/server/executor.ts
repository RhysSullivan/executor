import { Effect, Layer, ManagedRuntime, Context } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as SqlClient from "@effect/sql/SqlClient";
import { NodeFileSystem } from "@effect/platform-node";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createExecutor, scopeKv } from "@executor/sdk";
import { makeSqliteKv, makeKvConfig, makeScopedKv, migrate } from "@executor/storage-file";
import {
  openApiPlugin,
  makeKvOperationStore,
  withConfigFile as withOpenApiConfigFile,
} from "@executor/plugin-openapi";
import {
  mcpPlugin,
  makeKvBindingStore,
  withConfigFile as withMcpConfigFile,
  type McpSourceConfig,
} from "@executor/plugin-mcp";
import { loadConfig } from "@executor/config";
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
  mcpBindingStore?: ReturnType<typeof makeKvBindingStore>,
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
        mcpBindingStore ?? makeKvBindingStore(scopedKv, "mcp"),
        configPath,
        fsLayer,
      ),
    }),
    googleDiscoveryPlugin({
      bindingStore: makeKvGoogleDiscoveryBindingStore(scopedKv, "google-discovery"),
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

      // Keep raw binding store reference so we can check what's already registered
      const rawBindingStore = makeKvBindingStore(scopedKv, "mcp");
      const executor = yield* createExecutor({
        ...config,
        plugins: createLocalPlugins(scopedKv, configPath, fsLayer, rawBindingStore),
      });

      // Sync executor.jsonc → KV for MCP sources written offline (not yet in KV)
      const fileConfig = yield* loadConfig(configPath).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll(() => Effect.succeed(null)),
      );
      const mcpSources = (fileConfig?.sources ?? []).filter((s) => s.kind === "mcp");
      if (mcpSources.length > 0) {
        const existingSources = yield* rawBindingStore.listSources();
        const existingNamespaces = new Set(existingSources.map((s) => s.namespace));
        for (const source of mcpSources) {
          const ns = source.namespace ?? source.name;
          if (existingNamespaces.has(ns)) continue;
          // Strip config-file-only fields (kind, auth) — auth in file format uses
          // public secret refs, not secretIds; agent-imported sources have no auth anyway
          const mcpConfig: McpSourceConfig =
            source.transport === "stdio"
              ? {
                  transport: "stdio",
                  name: source.name,
                  command: source.command,
                  args: source.args ? [...source.args] : undefined,
                  env: source.env,
                  cwd: source.cwd,
                  namespace: source.namespace,
                }
              : {
                  transport: "remote",
                  name: source.name,
                  endpoint: source.endpoint,
                  remoteTransport: source.remoteTransport,
                  queryParams: source.queryParams,
                  headers: source.headers,
                  namespace: source.namespace,
                };
          yield* executor.mcp.addSource(mcpConfig).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() =>
                console.warn(`[startup] MCP source "${source.name}": ${e.message}`),
              ),
            ),
          );
        }
      }

      return executor;
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
