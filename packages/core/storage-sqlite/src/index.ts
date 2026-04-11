import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate as bunMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSqliteStores } from "./services";
import * as schema from "./schema";

export type DrizzleDb = BunSQLiteDatabase<typeof schema>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

/**
 * Open a file-backed SQLite database and return an `ExecutorStores` bundle.
 * Optionally runs migrations on first open (default: true).
 *
 * Usage:
 * ```ts
 * const stores = makeFileSqliteStores({ filename: "/path/to/data.db" });
 * const executor = yield* createExecutor({ scope, stores, encryptionKey, plugins });
 * ```
 */
export const makeFileSqliteStores = (options: {
  readonly filename: string;
  readonly migrate?: boolean;
}) => {
  const sqlite = new Database(options.filename);
  const db = drizzle(sqlite, { schema }) as unknown as DrizzleDb;
  if (options.migrate ?? true) {
    bunMigrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  }
  return makeSqliteStores(db);
};

/**
 * Open an in-memory SQLite database and return an `ExecutorStores` bundle.
 * Always runs migrations to bootstrap the schema.
 */
export const makeInMemorySqliteStores = () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema }) as unknown as DrizzleDb;
  bunMigrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  return makeSqliteStores(db);
};

export { makeSqliteStores } from "./services";
export * from "./schema";
