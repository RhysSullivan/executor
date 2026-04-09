// ---------------------------------------------------------------------------
// Database service — Hyperdrive on Cloudflare, node-postgres for local dev
// ---------------------------------------------------------------------------
//
// Migrations are run out-of-band (e.g. via a separate script or CI step),
// not at request time — Cloudflare Workers cannot read the filesystem.

import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import * as sharedSchema from "@executor/storage-postgres/schema";
import * as cloudSchema from "./schema";
import type { DrizzleDb } from "@executor/storage-postgres";
import { server } from "../env";

const schema = { ...sharedSchema, ...cloudSchema };

export type { DrizzleDb };

// ---------------------------------------------------------------------------
// Postgres via node-postgres (used with Hyperdrive or DATABASE_URL)
// ---------------------------------------------------------------------------

const acquirePostgres = (connectionString: string) =>
  Effect.tryPromise(async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Client } = await import("pg");
    const client = new Client({ connectionString });
    await client.connect();
    return { db: drizzle(client, { schema }) as DrizzleDb, client };
  });

const releasePostgres = ({
  client,
}: {
  client: { end: () => Promise<void> };
}) =>
  Effect.promise(() => client.end()).pipe(
    Effect.orElseSucceed(() => undefined),
  );

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DbService extends Context.Tag("@executor/cloud/DbService")<
  DbService,
  DrizzleDb
>() {
  static Live = Layer.scoped(
    this,
    Effect.gen(function* () {
      const connectionString =
        env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
      const { db } = yield* Effect.acquireRelease(
        acquirePostgres(connectionString),
        releasePostgres,
      );
      return db;
    }),
  );
}
