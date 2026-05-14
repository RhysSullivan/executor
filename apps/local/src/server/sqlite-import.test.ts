import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectTables } from "@executor-js/sdk";
import { createPgliteFumaDb, type PgliteFumaDb } from "@executor-js/sdk/pglite";

import { importSqliteDataToFuma } from "./sqlite-import";

let workDir: string;
let pglite: PgliteFumaDb | null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-sqlite-import-"));
  pglite = null;
});

afterEach(async () => {
  await pglite?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const seedSqlite = (path: string) => {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE source (
      id TEXT PRIMARY KEY NOT NULL,
      plugin_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT,
      can_remove INTEGER NOT NULL,
      can_refresh INTEGER NOT NULL,
      can_edit INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE blob (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);
  db.prepare(
    `INSERT INTO source (
      id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "src_1",
    "plugin",
    "remote",
    "Imported",
    null,
    1,
    0,
    1,
    1_700_000_000_000,
    1_700_000_001_000,
  );
  db.prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)").run(
    "scope_a/plugin",
    "spec",
    "{}",
  );
  db.close();
};

describe("importSqliteDataToFuma", () => {
  it("imports current SQLite rows into FumaDB/PGlite and moves the old DB aside", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "pglite-sqlite-imported");
    seedSqlite(sqlitePath);

    const tables = collectTables([]);
    pglite = await createPgliteFumaDb({
      tables,
      namespace: "executor_local_test",
      dataDir: join(workDir, "pglite"),
    });

    const result = await importSqliteDataToFuma({
      sqlitePath,
      markerPath,
      db: pglite.db,
      tables,
      scopeId: "scope_a",
    });

    expect(result.imported).toBe(true);
    expect(result.importedRows).toBe(2);
    expect(result.importedTables).toEqual(["source", "blob"]);
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(sqlitePath)).toBe(false);
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);

    const source = (await pglite.db.findFirst("source", {
      where: (b) => b("id", "=", "src_1"),
    })) as Record<string, unknown>;
    expect(source.scope_id).toBe("scope_a");
    expect(source.can_remove).toBe(true);
    expect(source.can_refresh).toBe(false);
    expect(source.can_edit).toBe(true);
    expect(source.created_at).toBeInstanceOf(Date);

    const blob = (await pglite.db.findFirst("blob", {
      where: (b) => b("id", "=", JSON.stringify(["scope_a/plugin", "spec"])),
    })) as Record<string, unknown>;
    expect(blob.value).toBe("{}");
  });
});
