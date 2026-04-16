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
import { server } from "../env";

const schema = { ...cloudSchema, ...executorSchema };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, any, any>;

export type DbServiceShape = {
  readonly sql: Sql;
  readonly db: DrizzleDb;
};

const resolveConnectionString = () => {
  // In local dev prefer an explicit DATABASE_URL (direct connection to
  // the PGlite socket server) so we bypass Miniflare's Hyperdrive proxy.
  // In production fall back to the Hyperdrive binding.
  if (server.DATABASE_URL) {
    return server.DATABASE_URL;
  }
  return env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
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
        return { sql, db: drizzle(sql, { schema }) as DrizzleDb };
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
