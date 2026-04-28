// ---------------------------------------------------------------------------
// Database service — Postgres via postgres.js (porsager)
// ---------------------------------------------------------------------------
//
// We use `postgres` (not `pg`) because Cloudflare Workers forbids sharing
// I/O objects across request handlers, and `pg`'s CloudflareSocket silently
// hangs when its Client is reused across requests. postgres.js creates a
// fresh TCP socket per Effect scope, which aligns with Workers' per-request
// I/O model. See personal-notes/pg-cloudflare-sockets-dev.md.
//
// Migrations are run out-of-band (e.g. via a separate script or CI step),
// not at request time — Cloudflare Workers cannot read the filesystem.

import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import * as cloudSchema from "./schema";
import * as executorSchema from "./executor-schema";

// Exported so every drizzle() call in the cloud app shares one schema
// object. Historically `mcp-session.ts` built its own and forgot to spread
// `executorSchema`, producing runtime "unknown model source" errors that
// only surfaced in prod. See apps/cloud/src/services/db.schema.test.ts.
export const combinedSchema = { ...cloudSchema, ...executorSchema };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, any, any>;

export type DbServiceShape = {
  readonly sql: Sql;
  readonly db: DrizzleDb;
};

export const resolveConnectionString = () => {
  // Production should always use Hyperdrive when the binding exists. Keeping
  // DATABASE_URL as a higher-priority fallback made it too easy for a deployed
  // secret to silently bypass Hyperdrive.
  if (env.EXECUTOR_DIRECT_DATABASE_URL === "true" && env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  return env.HYPERDRIVE?.connectionString || env.DATABASE_URL || "";
};

const makeSql = (): Sql =>
  postgres(resolveConnectionString(), {
    // max=1 is correct for Hyperdrive: one request, one connection. The
    // earlier deadlock under ctx.transaction (outer sql.begin holding the
    // only connection while nested writes pulled fresh ones) is fixed in
    // @executor/sdk — nested writes now thread through the active tx
    // handle via a FiberRef in buildAdapterRouter, so they reuse the same
    // connection and never contend with the outer sql.begin.
    max: 1,
    idle_timeout: 0,
    max_lifetime: 60,
    connect_timeout: 10,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });

export class DbService extends Context.Tag("@executor/cloud/DbService")<
  DbService,
  DbServiceShape
>() {
  static Live = Layer.scoped(
    this,
    Effect.acquireRelease(
      Effect.sync((): DbServiceShape => {
        const sql = makeSql();
        return { sql, db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb };
      }),
      ({ sql }) =>
        // Fire-and-forget: the Terminate round-trip sometimes hangs, and
        // we don't need to block scope close waiting for it.
        Effect.sync(() => {
          sql.end({ timeout: 0 }).catch(() => undefined);
        }),
    ),
  );
}
