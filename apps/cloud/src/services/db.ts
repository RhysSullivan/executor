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
import postgres from "postgres";
import * as sharedSchema from "@executor/storage-postgres/schema";
import * as cloudSchema from "./schema";
import type { DrizzleDb } from "@executor/storage-postgres";
import { server } from "../env";

const schema = { ...sharedSchema, ...cloudSchema };

export type { DrizzleDb };

const resolveConnectionString = () => {
  // In local dev prefer an explicit DATABASE_URL (direct connection to
  // the PGlite socket server) so we bypass Miniflare's Hyperdrive proxy.
  // In production fall back to the Hyperdrive binding.
  if (server.DATABASE_URL) {
    return server.DATABASE_URL;
  }
  return env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
};

const makeSql = () =>
  postgres(resolveConnectionString(), {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 60,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

export class DbService extends Context.Tag("@executor/cloud/DbService")<DbService, DrizzleDb>() {
  static Live = Layer.scoped(
    this,
    Effect.acquireRelease(
      Effect.sync(() => {
        const sql = makeSql();
        return { sql, db: drizzle(sql, { schema }) as DrizzleDb };
      }),
      ({ sql }) =>
        // Fire-and-forget: the Terminate round-trip sometimes hangs, and
        // we don't need to block scope close waiting for it.
        Effect.sync(() => {
          sql.end({ timeout: 0 }).catch(() => undefined);
        }),
    ).pipe(Effect.map(({ db }) => db)),
  );
}
