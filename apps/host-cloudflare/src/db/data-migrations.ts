import { Effect } from "effect";
import type { D1Database, D1DatabaseSession, R2Bucket } from "@cloudflare/workers-types";

import {
  DataMigrationError,
  runSqliteDataMigrations,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk";
import { googleOpenApiOwnershipDataMigration } from "@executor-js/plugin-google";

const TX_CONTROL = new Set(["BEGIN", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"]);

const firstWord = (sql: string): string => sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "";

const queryRows = <T extends Record<string, unknown>>(
  session: D1DatabaseSession,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
): Promise<readonly T[]> => {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  const args = typeof stmt === "string" ? [] : stmt.args;
  const prepared = session.prepare(sql).bind(...args);
  if (firstWord(sql) === "SELECT") {
    return prepared.all<T>().then((result) => result.results);
  }
  return prepared.run<T>().then(() => []);
};

export const d1DataMigrationClient = (db: D1Database): SqliteDataMigrationClient => {
  const session = db.withSession("first-primary");
  return {
    execute: (stmt) => {
      const sql =
        typeof stmt === "string" ? stmt.trim().toUpperCase() : stmt.sql.trim().toUpperCase();
      if (TX_CONTROL.has(sql)) return Promise.resolve({ rows: [] });
      return queryRows(session, stmt).then((rows) => ({ rows }));
    },
  };
};

const r2ObjectName = (tenant: string, pluginId: string, key: string): string =>
  `o:${tenant}/${pluginId}/${key}`;

const copyGoogleOpenApiSpecBlobsToR2 = (
  client: SqliteDataMigrationClient,
  bucket: R2Bucket,
): Effect.Effect<void, DataMigrationError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.execute(
        `SELECT tenant, json_extract(config, '$.specHash') AS spec_hash
         FROM integration
         WHERE plugin_id = 'openapi'
           AND config IS NOT NULL
           AND json_type(config, '$.googleDiscoveryUrls') = 'array'
           AND json_extract(config, '$.specHash') IS NOT NULL
           AND json_extract(config, '$.specHash') <> ''`,
      );
      for (const row of result.rows) {
        if (typeof row.tenant !== "string" || typeof row.spec_hash !== "string") continue;
        const key = `spec/${row.spec_hash}`;
        const target = r2ObjectName(row.tenant, "google", key);
        if ((await bucket.head(target)) != null) continue;
        const source = await bucket.get(r2ObjectName(row.tenant, "openapi", key));
        if (source == null) continue;
        await bucket.put(target, await source.text());
      }
    },
    catch: (cause) =>
      new DataMigrationError({ migration: googleOpenApiOwnershipDataMigration.name, cause }),
  });

const cloudflareDataMigrations = (bucket: R2Bucket | undefined): readonly SqliteDataMigration[] => [
  {
    name: googleOpenApiOwnershipDataMigration.name,
    run: (client) =>
      Effect.gen(function* () {
        if (bucket) yield* copyGoogleOpenApiSpecBlobsToR2(client, bucket);
        yield* googleOpenApiOwnershipDataMigration.run(client);
      }),
  },
];

export const runCloudflareDataMigrations = (
  db: D1Database,
  bucket: R2Bucket | undefined,
): Promise<readonly string[]> =>
  Effect.runPromise(
    runSqliteDataMigrations(d1DataMigrationClient(db), cloudflareDataMigrations(bucket)),
  );
