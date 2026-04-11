import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import type { DrizzleDb } from "../db";
import * as schema from "../schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle");

export interface InMemorySqliteDb {
  readonly db: DrizzleDb;
  readonly close: () => void;
}

export const createInMemorySqliteDb = (): Effect.Effect<InMemorySqliteDb> =>
  Effect.sync(() => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema }) as unknown as DrizzleDb;
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    return {
      db,
      close: (): void => {
        sqlite.close();
      },
    };
  });
