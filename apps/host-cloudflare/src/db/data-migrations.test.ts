import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { collectTables, type SqliteDataMigrationClient } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { runCloudflareDataMigrations } from "./data-migrations";

const now = 1_780_000_000_000;

const makeFakeD1 = (client: SqliteDataMigrationClient): D1Database => {
  const prepare = (sql: string) => {
    const statement = (args: readonly unknown[]): Record<string, unknown> => ({
      bind: (...values: readonly unknown[]) => statement([...args, ...values]),
      all: async () => {
        const result = await client.execute({ sql, args });
        return { success: true, meta: {}, results: result.rows };
      },
      run: async () => {
        await client.execute({ sql, args });
        return { success: true, meta: {}, results: [] };
      },
    });
    return statement([]);
  };

  // oxlint-disable-next-line executor/no-double-cast -- test double: only the D1 methods used by the migration runner are implemented
  return {
    prepare,
    withSession: () => ({ prepare }),
  } as unknown as D1Database;
};

const makeFakeR2 = (): { readonly bucket: R2Bucket; readonly objects: Map<string, string> } => {
  const objects = new Map<string, string>();
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the R2 methods used by the migration are implemented
  const bucket = {
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key: string, value: string) => {
      objects.set(key, value);
    },
    head: async (key: string) => (objects.has(key) ? {} : null),
  } as unknown as R2Bucket;
  return { bucket, objects };
};

const insertIntegration = (
  client: SqliteDataMigrationClient,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly slug: string;
    readonly pluginId: string;
    readonly config: unknown;
  },
) =>
  client.execute({
    sql: `INSERT INTO integration
      (row_id, tenant, slug, plugin_id, name, description, config, can_remove, can_refresh, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      row.slug,
      row.pluginId,
      row.slug,
      row.slug,
      JSON.stringify(row.config),
      now,
      now,
    ],
  });

const insertOperationStorage = (
  client: SqliteDataMigrationClient,
  row: {
    readonly tenant: string;
    readonly pluginId: string;
    readonly integration: string;
  },
) =>
  client.execute({
    sql: `INSERT INTO plugin_storage
      (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
      VALUES (?, 'org', '', ?, 'operation', ?, ?, ?, ?, ?)`,
    args: [
      row.tenant,
      row.pluginId,
      `${row.integration}.items.list`,
      JSON.stringify({
        integration: row.integration,
        toolName: "items.list",
        binding: { method: "get", pathTemplate: "/items" },
      }),
      now,
      now,
      `storage-${row.pluginId}-${row.integration}`,
    ],
  });

describe("runCloudflareDataMigrations", () => {
  it.effect("moves Google OpenAPI ownership and copies the R2 spec object", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const { bucket, objects } = makeFakeR2();

      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "google-row",
          tenant: "org_1",
          slug: "google",
          pluginId: "openapi",
          config: {
            specHash: "googlehash",
            googleDiscoveryUrls: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
          },
        }),
      );
      yield* Effect.promise(() =>
        insertOperationStorage(db.client, {
          tenant: "org_1",
          pluginId: "openapi",
          integration: "google",
        }),
      );
      objects.set("o:org_1/openapi/spec/googlehash", "google spec");

      const d1 = makeFakeD1(db.client);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toEqual([
        "2026-06-20-google-openapi-ownership",
      ]);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toEqual([]);

      expect(objects.get("o:org_1/google/spec/googlehash")).toBe("google spec");

      const integrations = yield* Effect.promise(() =>
        db.client.execute("SELECT slug, plugin_id FROM integration ORDER BY slug"),
      );
      expect(integrations.rows).toEqual([{ slug: "google", plugin_id: "google" }]);

      const storage = yield* Effect.promise(() =>
        db.client.execute("SELECT plugin_id, key FROM plugin_storage ORDER BY plugin_id, key"),
      );
      expect(storage.rows).toEqual([{ plugin_id: "google", key: "google.items.list" }]);

      yield* Effect.promise(() => db.close());
    }),
  );
});
