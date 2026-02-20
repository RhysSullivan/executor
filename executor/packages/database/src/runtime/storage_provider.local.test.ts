import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageInstanceRecord } from "../../../core/src/types";
import { getStorageProvider, resetStorageProviderSingletonsForTests } from "./storage_provider";

function makeInstance(id: string): StorageInstanceRecord {
  const now = Date.now();
  return {
    id,
    scopeType: "scratch",
    durability: "durable",
    status: "active",
    provider: "agentfs-local",
    backendKey: id,
    organizationId: `org_${id}` as StorageInstanceRecord["organizationId"],
    workspaceId: `ws_${id}` as StorageInstanceRecord["workspaceId"],
    accountId: `acct_${id}` as StorageInstanceRecord["accountId"],
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

describe("agentfs-local storage provider", () => {
  let previousConvexUrl: string | undefined;
  let previousConvexSiteUrl: string | undefined;
  let previousStorageRoot: string | undefined;
  let tempRoot = "";

  beforeEach(async () => {
    previousConvexUrl = process.env.CONVEX_URL;
    previousConvexSiteUrl = process.env.CONVEX_SITE_URL;
    previousStorageRoot = process.env.AGENT_STORAGE_ROOT;
    process.env.CONVEX_URL = "http://127.0.0.1:3210";
    process.env.CONVEX_SITE_URL = "http://127.0.0.1:3211";
    tempRoot = await mkdtemp(join(tmpdir(), "storage-provider-local-"));
    process.env.AGENT_STORAGE_ROOT = tempRoot;
    resetStorageProviderSingletonsForTests();
  });

  afterEach(async () => {
    resetStorageProviderSingletonsForTests();
    if (previousConvexUrl === undefined) {
      delete process.env.CONVEX_URL;
    } else {
      process.env.CONVEX_URL = previousConvexUrl;
    }

    if (previousConvexSiteUrl === undefined) {
      delete process.env.CONVEX_SITE_URL;
    } else {
      process.env.CONVEX_SITE_URL = previousConvexSiteUrl;
    }

    if (previousStorageRoot === undefined) {
      delete process.env.AGENT_STORAGE_ROOT;
    } else {
      process.env.AGENT_STORAGE_ROOT = previousStorageRoot;
    }

    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("serializes concurrent SQLite writes for a single instance", async () => {
    const provider = getStorageProvider("agentfs-local");
    const instance = makeInstance("inst_concurrent_sqlite");

    await provider.sqliteQuery(instance, {
      sql: "CREATE TABLE IF NOT EXISTS smoke (id TEXT PRIMARY KEY, value INTEGER)",
      params: [],
      mode: "write",
      maxRows: 1,
    });

    const writeCount = 40;
    await Promise.all(
      Array.from({ length: writeCount }).map((_, index) =>
        provider.sqliteQuery(instance, {
          sql: "INSERT INTO smoke (id, value) VALUES (?, ?)",
          params: [`id_${index}`, index],
          mode: "write",
          maxRows: 1,
        })
      ),
    );

    const result = await provider.sqliteQuery(instance, {
      sql: "SELECT COUNT(*) AS count FROM smoke",
      params: [],
      mode: "read",
      maxRows: 1,
    });

    const row = result.rows?.[0] as { count?: number } | undefined;
    expect(row?.count).toBe(writeCount);
  });
});
