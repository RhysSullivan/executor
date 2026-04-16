// ---------------------------------------------------------------------------
// Postgres adapter conformance test
// ---------------------------------------------------------------------------
//
// Gated on TEST_POSTGRES_URL. When unset (the default for local `vitest
// run`) the suite registers a single skipped test and exits — so contribs
// without Docker/Postgres still get a green local run. CI is expected to
// set TEST_POSTGRES_URL against a throw-away database.
//
// Example:
//   TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/executor_test \
//     bun --filter @executor/storage-postgres test

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import postgres from "postgres";

import type { DBAdapter } from "@executor/storage-core";
import {
  conformanceSchema,
  runAdapterConformance,
} from "@executor/storage-core/testing";

import { makePostgresAdapter } from "./index";

const url = process.env.TEST_POSTGRES_URL;

if (!url) {
  describe("conformance: postgres", () => {
    it.skip("TEST_POSTGRES_URL not set — skipping real-postgres conformance", () => {
      // no-op: see header comment
    });
  });
} else {
  const sql = postgres(url, {
    max: 5,
    idle_timeout: 0,
    max_lifetime: 60,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

  // TEST-ONLY DDL. The storage-postgres package no longer ships a runtime
  // migrator; production consumers run drizzle-kit. The conformance suite
  // needs a deterministic empty schema before each run, so we issue raw
  // CREATE TABLE IF NOT EXISTS statements for the two `conformanceSchema`
  // models here. Keep these in sync with
  // storage-core/src/testing/conformance.ts.
  const createConformanceTables = Effect.tryPromise({
    try: async () => {
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS "source" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT,
          "priority" DOUBLE PRECISION,
          "enabled" BOOLEAN,
          "createdAt" TIMESTAMPTZ,
          "metadata" JSONB
        )`,
      );
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS "tag" (
          "id" TEXT PRIMARY KEY,
          "label" TEXT
        )`,
      );
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS "source_tag" (
          "id" TEXT PRIMARY KEY,
          "sourceId" TEXT REFERENCES "source"("id") ON DELETE CASCADE,
          "note" TEXT
        )`,
      );
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS "with_defaults" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT,
          "nickname" TEXT,
          "touchedAt" TIMESTAMPTZ
        )`,
      );
    },
    catch: (cause) =>
      new Error(
        `failed to create postgres conformance tables: ${String(cause)}`,
      ),
  });

  // Every test starts from an empty schema. We DROP + recreate explicitly;
  // the adapter itself no longer issues DDL on construction.
  const resetTables = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        sql`DROP TABLE IF EXISTS "source", "tag", "source_tag", "with_defaults", "blob" CASCADE`.then(
          () => undefined,
        ),
      catch: (cause) =>
        new Error(
          `failed to reset postgres conformance tables: ${String(cause)}`,
        ),
    });
    yield* createConformanceTables;
  });

  const withAdapter = <A, E>(
    fn: (adapter: DBAdapter) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Error> =>
    Effect.gen(function* () {
      yield* resetTables;
      const adapter = yield* makePostgresAdapter({
        sql,
        schema: conformanceSchema,
      });
      return yield* fn(adapter);
    }) as Effect.Effect<A, E | Error>;

  runAdapterConformance("postgres", withAdapter);
}
