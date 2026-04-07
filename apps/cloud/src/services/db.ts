// ---------------------------------------------------------------------------
// Database service — PGlite for dev, node-postgres for prod
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import * as schema from "@executor/storage-postgres";
import type { DrizzleDb } from "@executor/storage-postgres";

export type { DrizzleDb };

const MIGRATIONS_DIR = resolve(
  import.meta.dirname,
  "../../../../packages/core/storage-postgres/drizzle",
);

let db: DrizzleDb | null = null;

export const getDb = async (): Promise<DrizzleDb> => {
  if (db) return db;

  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema }) as DrizzleDb;
    await migrate(db as any, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dataDir = process.env.PGLITE_DATA_DIR ?? ".pglite";
    const client = new PGlite(dataDir);
    db = drizzle(client, { schema }) as DrizzleDb;
    await migrate(db as any, { migrationsFolder: MIGRATIONS_DIR });
  }

  return db;
};
