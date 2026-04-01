import { Context, Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as SqlClient from "@effect/sql/SqlClient";
import * as fs from "node:fs";

import { createExecutor, scopeKv } from "@executor/sdk";
import { makeSqliteKv, makeKvConfig, migrate } from "@executor/storage-file";
import { openApiPlugin, makeKvOperationStore, type OpenApiPluginExtension } from "@executor/plugin-openapi";

import type { Executor, ExecutorPlugin } from "@executor/sdk";

type ServerPlugins = readonly [ExecutorPlugin<"openapi", OpenApiPluginExtension>];
type ServerExecutor = Executor<ServerPlugins>;

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class ExecutorService extends Context.Tag("ExecutorService")<
  ExecutorService,
  ServerExecutor
>() {}

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.EXECUTOR_DATA_DIR
  ?? `${import.meta.dirname}/../../../../.executor-data`;

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = `${DATA_DIR}/data.db`;

// ---------------------------------------------------------------------------
// Layer — SQLite-backed executor with persistent plugin state
// ---------------------------------------------------------------------------

export const ExecutorServiceLive = Layer.effect(
  ExecutorService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Run migrations
    yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));

    // Single KV for everything
    const kv = makeSqliteKv(sql);
    const config = makeKvConfig(kv);

    return yield* createExecutor({
      ...config,
      plugins: [
        openApiPlugin({
          operationStore: makeKvOperationStore(scopeKv(kv, "openapi")),
        }),
      ] as const,
    });
  }),
).pipe(
  Layer.provide(SqliteClient.layer({ filename: DB_PATH })),
);
