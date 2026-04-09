// ---------------------------------------------------------------------------
// Database service — Hyperdrive on Cloudflare, node-postgres for local dev
// ---------------------------------------------------------------------------
//
// Migrations are run out-of-band (e.g. via a separate script or CI step),
// not at request time — Cloudflare Workers cannot read the filesystem.

import { Context, Effect, Layer } from "effect";
import * as sharedSchema from "@executor/storage-postgres/schema";
import * as cloudSchema from "./schema";
import type { DrizzleDb } from "@executor/storage-postgres";
import { server } from "../env";

const schema = { ...sharedSchema, ...cloudSchema };

export type { DrizzleDb };

// ---------------------------------------------------------------------------
// Connection string resolution
// ---------------------------------------------------------------------------

const resolveHyperdriveUrl = Effect.tryPromise({
  try: async () => {
    const { env } = await import("cloudflare:workers");
    const hyperdrive = (env as any).HYPERDRIVE;
    return (hyperdrive?.connectionString as string) ?? null;
  },
  catch: () => null,
}).pipe(Effect.map((v) => v ?? undefined));

const resolveConnectionString = resolveHyperdriveUrl.pipe(
  Effect.map((url) => url ?? (server.DATABASE_URL || undefined)),
  Effect.flatMap((url) =>
    url
      ? Effect.succeed(url)
      : Effect.fail(new Error("No database connection string available (set DATABASE_URL or configure Hyperdrive)")),
  ),
);

// ---------------------------------------------------------------------------
// Postgres via node-postgres (used with Hyperdrive or DATABASE_URL)
// ---------------------------------------------------------------------------

const acquirePostgres = (connectionString: string) =>
  Effect.tryPromise(async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Client } = await import("pg");
    // Use Client (not Pool) — Hyperdrive manages connection pooling externally.
    const client = new Client({ connectionString });
    await client.connect();
    return { db: drizzle(client, { schema }) as DrizzleDb, client };
  });

const releasePostgres = ({ client }: { client: { end: () => Promise<void> } }) =>
  Effect.promise(() => client.end()).pipe(Effect.orElseSucceed(() => undefined));

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
      const connectionString = yield* resolveConnectionString;
      const { db } = yield* Effect.acquireRelease(
        acquirePostgres(connectionString),
        releasePostgres,
      );
      return db;
    }),
  );
}
