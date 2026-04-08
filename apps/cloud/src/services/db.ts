// ---------------------------------------------------------------------------
// Database service — PGlite for dev, node-postgres for prod
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";
import { resolve } from "node:path";
import * as sharedSchema from "@executor/storage-postgres/schema";
import * as cloudSchema from "./schema";
import type { DrizzleDb } from "@executor/storage-postgres";

const schema = { ...sharedSchema, ...cloudSchema };

export type { DrizzleDb };

const MIGRATIONS_DIR = resolve(
  import.meta.dirname,
  "../../../../packages/core/storage-postgres/drizzle",
);

type DbResource = {
  readonly db: DrizzleDb;
  readonly close: () => Promise<void>;
};

const createDbResource = async (): Promise<DbResource> => {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool, { schema }) as DrizzleDb;
    await migrate(db as any, { migrationsFolder: MIGRATIONS_DIR });
    return {
      db,
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dataDir = process.env.PGLITE_DATA_DIR ?? ".pglite";
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema }) as DrizzleDb;
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return {
    db,
    close: async () => {
      const closeClient = client.close;
      if (closeClient) {
        await closeClient.call(client);
      }
    },
  };
};

const closeDbResource = (resource: DbResource) =>
  Effect.promise(() => resource.close()).pipe(
    Effect.orElseSucceed(() => undefined),
  );

export class DbService extends Context.Tag("@executor/cloud/DbService")<
  DbService,
  DrizzleDb
>() {
  static Live = Layer.scoped(
    this,
    Effect.acquireRelease(
      Effect.promise(() => createDbResource()),
      closeDbResource,
    ).pipe(Effect.map((resource) => resource.db)),
  );
}
