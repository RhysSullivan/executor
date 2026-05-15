// Upgrade path for local DBs written by pre-scope executor versions.
//
// These helpers still run before the one-shot FumaDB import. They detect
// SQLite files whose core tables predate `scope_id`, move the file set aside,
// and preserve legacy secret routing rows for the fresh scoped database.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  importLegacySecrets,
  isPreScopeSchema,
  moveAsidePreScopeDb,
  readLegacySecrets,
} from "./db-upgrade";

const PRE_SCOPE_SCHEMA = `
  CREATE TABLE source (
    id TEXT PRIMARY KEY NOT NULL,
    plugin_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    can_remove INTEGER DEFAULT 1 NOT NULL,
    can_refresh INTEGER DEFAULT 0 NOT NULL,
    can_edit INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE tool (
    id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE secret (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE blob (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  );
`;

const SCOPED_SCHEMA = `
  CREATE TABLE source (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    can_remove INTEGER DEFAULT 1 NOT NULL,
    can_refresh INTEGER DEFAULT 0 NOT NULL,
    can_edit INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );
`;

const seed = (path: string, sql: string) => {
  const db = new Database(path);
  db.exec(sql);
  db.close();
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "exec-dbup-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("isPreScopeSchema", () => {
  it("returns true for a DB with a source table missing scope_id", () => {
    const path = join(workDir, "data.db");
    seed(path, PRE_SCOPE_SCHEMA);
    expect(isPreScopeSchema(path)).toBe(true);
  });

  it("returns false for a DB whose source table already has scope_id", () => {
    const path = join(workDir, "data.db");
    seed(path, SCOPED_SCHEMA);
    expect(isPreScopeSchema(path)).toBe(false);
  });

  it("returns false for a DB with no source table", () => {
    const path = join(workDir, "data.db");
    seed(path, "CREATE TABLE unrelated (x TEXT);");
    expect(isPreScopeSchema(path)).toBe(false);
  });

  it("returns false when the DB file doesn't exist", () => {
    expect(isPreScopeSchema(join(workDir, "missing.db"))).toBe(false);
  });
});

describe("moveAsidePreScopeDb", () => {
  it("renames data.db + wal/shm siblings and returns the backup path", () => {
    const path = join(workDir, "data.db");
    seed(path, PRE_SCOPE_SCHEMA);
    writeFileSync(`${path}-wal`, "wal-bytes");
    writeFileSync(`${path}-shm`, "shm-bytes");

    const backup = moveAsidePreScopeDb(path);
    expect(backup).toMatch(/data\.db\.pre-scopes-\d+-[0-9a-f]{8}$/);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(backup!)).toBe(true);
    expect(existsSync(`${backup}-wal`)).toBe(true);
    expect(existsSync(`${backup}-shm`)).toBe(true);
  });

  it("is a no-op when the DB already has the scoped schema", () => {
    const path = join(workDir, "data.db");
    seed(path, SCOPED_SCHEMA);
    expect(moveAsidePreScopeDb(path)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("is a no-op when the DB doesn't exist yet", () => {
    expect(moveAsidePreScopeDb(join(workDir, "missing.db"))).toBeNull();
  });
});

describe("move-aside + fresh migrate end-to-end", () => {
  it("lets migrations run cleanly after an old DB is moved aside", () => {
    const path = join(workDir, "data.db");
    seed(path, PRE_SCOPE_SCHEMA);

    const backup = moveAsidePreScopeDb(path);
    expect(backup).not.toBeNull();

    const db = new Database(path);
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });
    const cols = db.prepare("PRAGMA table_info('source')").all() as ReadonlyArray<{
      readonly name: string;
    }>;
    db.close();
    expect(cols.some((c) => c.name === "scope_id")).toBe(true);
  });
});

describe("readLegacySecrets", () => {
  it("returns all rows from a pre-scope DB's secret table", () => {
    const path = join(workDir, "data.db");
    seed(path, PRE_SCOPE_SCHEMA);
    const db = new Database(path);
    db.prepare("INSERT INTO secret (id, name, provider, created_at) VALUES (?, ?, ?, ?)").run(
      "sec_1",
      "GitHub Token",
      "onepassword",
      1_700_000_000,
    );
    db.prepare("INSERT INTO secret (id, name, provider, created_at) VALUES (?, ?, ?, ?)").run(
      "sec_2",
      "Stripe",
      "keychain",
      1_700_000_001,
    );
    db.close();

    const rows = readLegacySecrets(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "sec_1",
      name: "GitHub Token",
      provider: "onepassword",
      createdAt: 1_700_000_000,
    });
  });

  it("returns [] when the DB has no secret table", () => {
    const path = join(workDir, "data.db");
    seed(path, "CREATE TABLE unrelated (x TEXT);");
    expect(readLegacySecrets(path)).toEqual([]);
  });

  it("returns [] when the DB file doesn't exist", () => {
    expect(readLegacySecrets(join(workDir, "missing.db"))).toEqual([]);
  });
});

describe("importLegacySecrets", () => {
  const createScopedDb = (path: string): Database => {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE secret (
        id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope_id, id)
      );
    `);
    return db;
  };

  it("inserts rows stamped with the given scope id", () => {
    const path = join(workDir, "data.db");
    const db = createScopedDb(path);
    importLegacySecrets(db, "scope_a", [
      { id: "sec_1", name: "GH", provider: "onepassword", createdAt: 1 },
      { id: "sec_2", name: "St", provider: "keychain", createdAt: 2 },
    ]);
    const rows = db
      .prepare("SELECT id, scope_id, name, provider FROM secret ORDER BY id")
      .all() as ReadonlyArray<{ id: string; scope_id: string; name: string; provider: string }>;
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "sec_1",
      scope_id: "scope_a",
      name: "GH",
      provider: "onepassword",
    });
    expect(rows[1].scope_id).toBe("scope_a");
  });

  it("is a no-op with an empty list", () => {
    const path = join(workDir, "data.db");
    const db = createScopedDb(path);
    importLegacySecrets(db, "scope_a", []);
    const count = (db.prepare("SELECT COUNT(*) as n FROM secret").get() as { n: number }).n;
    db.close();
    expect(count).toBe(0);
  });

  it("uses INSERT OR IGNORE so a second import of the same ids is a no-op", () => {
    const path = join(workDir, "data.db");
    const db = createScopedDb(path);
    const rows = [{ id: "sec_1", name: "GH", provider: "onepassword", createdAt: 1 }];
    importLegacySecrets(db, "scope_a", rows);
    db.prepare(
      "UPDATE secret SET provider = 'file' WHERE id = 'sec_1' AND scope_id = 'scope_a'",
    ).run();
    importLegacySecrets(db, "scope_a", rows);
    const provider = (
      db
        .prepare("SELECT provider FROM secret WHERE id = ? AND scope_id = ?")
        .get("sec_1", "scope_a") as { provider: string }
    ).provider;
    db.close();
    expect(provider).toBe("file");
  });
});
