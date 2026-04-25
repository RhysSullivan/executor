import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyConnections } from "./migrate-connections";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-migrate-connections-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const columnNames = (db: Database, table: string): ReadonlyArray<string> =>
  (
    db.prepare(`PRAGMA table_info('${table}')`).all() as ReadonlyArray<{
      readonly name: string;
    }>
  ).map((column) => column.name);

describe("migrateLegacyConnections", () => {
  it("backfills legacy MCP OAuth rows after connection.kind has been dropped", async () => {
    const db = new Database(join(workDir, "data.db"));
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });

    expect(columnNames(db, "connection")).not.toContain("kind");

    const now = Date.now();
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "access-token", "Access token", "keychain", now);
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "refresh-token", "Refresh token", "keychain", now);
    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "scope-1",
      "remote-mcp",
      "Remote MCP",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://example.com/mcp",
        auth: {
          kind: "oauth2",
          accessTokenSecretId: "access-token",
          refreshTokenSecretId: "refresh-token",
          tokenType: "Bearer",
          expiresAt: null,
          scope: "read",
          clientInformation: null,
          authorizationServerUrl: null,
          resourceMetadataUrl: null,
        },
      }),
      now,
    );

    await migrateLegacyConnections(db);

    const connection = db
      .prepare(
        "SELECT id, provider, access_token_secret_id, refresh_token_secret_id FROM connection WHERE scope_id = ?",
      )
      .get("scope-1") as
      | {
          readonly id: string;
          readonly provider: string;
          readonly access_token_secret_id: string;
          readonly refresh_token_secret_id: string | null;
        }
      | undefined;
    expect(connection).toEqual({
      id: "mcp-oauth2-remote-mcp",
      provider: "mcp:oauth2",
      access_token_secret_id: "access-token",
      refresh_token_secret_id: "refresh-token",
    });

    const source = db
      .prepare("SELECT config FROM mcp_source WHERE scope_id = ? AND id = ?")
      .get("scope-1", "remote-mcp") as { readonly config: string };
    expect(JSON.parse(source.config).auth).toEqual({
      kind: "oauth2",
      connectionId: "mcp-oauth2-remote-mcp",
    });

    const ownedSecrets = db
      .prepare(
        "SELECT id, owned_by_connection_id FROM secret WHERE scope_id = ? ORDER BY id",
      )
      .all("scope-1");
    expect(ownedSecrets).toEqual([
      {
        id: "access-token",
        owned_by_connection_id: "mcp-oauth2-remote-mcp",
      },
      {
        id: "refresh-token",
        owned_by_connection_id: "mcp-oauth2-remote-mcp",
      },
    ]);

    db.close();
  });
});
