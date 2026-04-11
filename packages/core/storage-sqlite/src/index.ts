import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate as bunMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { makeSqliteServices, type SqliteServicesOptions } from "./services";
import * as schema from "./schema";

export type DrizzleDb = BunSQLiteDatabase<typeof schema>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

export interface FileSqliteServicesOptions extends SqliteServicesOptions {
  readonly filename: string;
  readonly migrate?: boolean;
}

export const makeFileSqliteServices = (options: FileSqliteServicesOptions) =>
  Effect.gen(function* () {
    const sqlite = new Database(options.filename);
    const db = drizzle(sqlite, { schema }) as unknown as DrizzleDb;
    if (options.migrate ?? true) {
      bunMigrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    }
    return yield* makeSqliteServices(db, options);
  });

export interface InMemorySqliteServicesOptions extends SqliteServicesOptions {}

export const makeInMemorySqliteServices = (options: InMemorySqliteServicesOptions) =>
  Effect.gen(function* () {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema }) as unknown as DrizzleDb;
    bunMigrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    return yield* makeSqliteServices(db, options);
  });

export { makeSqliteServices, type SqliteServicesOptions } from "./services";
export * from "./schema";
