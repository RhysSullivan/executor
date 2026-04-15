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
import { server } from "../env";

const schema = { ...cloudSchema };

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
    // max=5: ctx.transaction() opens a sql.begin on one connection
    // while nested writes (ctx.core.sources.register, plugin storage,
    // etc.) currently route through the root rootSql reference —
    // which pulls separate connections from the pool. With max=1 this
    // deadlocks immediately because the tx holds the only connection
    // and the nested writes wait forever for one to free up. 5 gives
    // headroom for openapi addSpec which hits plugin storage + core
    // sources + core definitions writes inside one logical
    // "transaction".
    //
    // TODO: thread the active tx client through nested adapter writes
    // (via FiberRef / Context layer substitution) so the writes are
    // actually atomic AND pool=1 works again. Tracked separately.
    max: 5,
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
