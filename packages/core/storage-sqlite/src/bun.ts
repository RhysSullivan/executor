// ---------------------------------------------------------------------------
// @executor/storage-sqlite/bun — bun:sqlite factories
//
// Use this entry point when running under Bun. Bun's native `bun:sqlite`
// module is faster and avoids the `better-sqlite3` native module load
// failure on current Bun releases.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Effect } from "effect";

import type { ExecutorStorage, StorageError } from "@executor/storage";

import {
  makeSqliteStorage,
  type SqliteRunner,
  type SqliteStorageOptions,
} from "./core";

export {
  makeSqliteStorage,
  sqliteCapabilities,
  type SqliteRunner,
  type SqliteStorageOptions,
} from "./core";

export interface FileSqliteStorageOptions extends SqliteStorageOptions {
  readonly filename: string;
}

export const makeInMemorySqliteStorage = (
  options?: SqliteStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> =>
  makeFileSqliteStorage({ ...options, filename: ":memory:" });

export const makeFileSqliteStorage = (
  options: FileSqliteStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> => {
  const db = drizzle(new Database(options.filename)) as unknown as SqliteRunner;
  return makeSqliteStorage(db, options);
};
