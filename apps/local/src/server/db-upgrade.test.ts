// Upgrade path for local DBs written by pre-scope executor versions.
//
// These tests exercise both halves:
//   1. The detector correctly identifies DBs missing the `scope_id`
//      column on `source`.
//   2. The move-aside helper renames the file (plus WAL/SHM siblings)
//      so a subsequent fresh `migrate()` can create the new shape.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

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

  it("is a no-op when the DB doesn't exist yet (fresh install)", () => {
    expect(moveAsidePreScopeDb(join(workDir, "missing.db"))).toBeNull();
  });
});

// Integration: the whole reason this helper exists — a pre-scope DB
// must be recoverable via fresh drizzle migrations after the move.
describe("move-aside + fresh migrate end-to-end", () => {
  it("lets migrations run cleanly after an old DB is moved aside", () => {
    const path = join(workDir, "data.db");
    seed(path, PRE_SCOPE_SCHEMA);

    const backup = moveAsidePreScopeDb(path);
    expect(backup).not.toBeNull();

    const db = new Database(path);
    migrate(drizzle(db), {
      migrationsFolder: join(__dirname, "../../drizzle"),
    });
    // migrate() should have produced the new schema — source now has scope_id.
    const cols = db
      .prepare("PRAGMA table_info('source')")
      .all() as ReadonlyArray<{ readonly name: string }>;
    expect(cols.some((c) => c.name === "scope_id")).toBe(true);
    db.close();
  });
});

describe("readLegacySecrets", () => {
  it("returns all rows from a pre-scope DB's secret table", () => {
    const path = join(workDir, "data.db");
    seed(path, PRE_SCOPE_SCHEMA);
    const db = new Database(path);
    db.prepare(
      "INSERT INTO secret (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
    ).run("sec_1", "GitHub Token", "onepassword", 1700000000);
    db.prepare(
      "INSERT INTO secret (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
    ).run("sec_2", "Stripe", "keychain", 1700000001);
    db.close();

    const rows = readLegacySecrets(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "sec_1",
      name: "GitHub Token",
      provider: "onepassword",
      createdAt: 1700000000,
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
  // Set up a fresh DB with the new (scoped) `secret` shape to import into.
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
    const rows = [
      { id: "sec_1", name: "GH", provider: "onepassword", createdAt: 1 },
    ];
    importLegacySecrets(db, "scope_a", rows);
    // If the user's already re-registered the secret via a different
    // provider, the legacy row must NOT clobber it.
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
