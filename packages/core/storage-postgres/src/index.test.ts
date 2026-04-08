import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  createExecutor,
  ScopeId,
  ToolId,
  SecretId,
  ToolRegistration,
  scopeKv,
  type Executor,
} from "@executor/core";

import { makePgConfig } from "./index";
import { makePgKv } from "./pg-kv";
import { makeUserStore } from "./user-store";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Test setup — in-memory Postgres via PGlite + Drizzle migrations
// ---------------------------------------------------------------------------

const TEST_TEAM_ID = "test-team-1";
const TEST_TEAM_NAME = "Test Team";
const TEST_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../drizzle");

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE plugin_kv, policies, secrets, tool_definitions, tools, sources, invitations, team_members, teams, users`,
  );
});

afterAll(async () => {
  await client.close();
});

// ---------------------------------------------------------------------------
// Helper — create executor from PgConfig
// ---------------------------------------------------------------------------

const makeTestExecutor = () => {
  const config = makePgConfig(db, {
    teamId: TEST_TEAM_ID,
    teamName: TEST_TEAM_NAME,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  return createExecutor(config);
};

const makeTestExecutorForTeam = (teamId: string, teamName: string) => {
  const config = makePgConfig(db, {
    teamId,
    teamName,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  return createExecutor(config);
};

// ---------------------------------------------------------------------------
// Executor via makePgConfig
// ---------------------------------------------------------------------------

describe("Executor with Postgres storage", () => {
  it.effect("scope reflects team", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      expect(executor.scope.id).toBe(TEST_TEAM_ID);
      expect(executor.scope.name).toBe(TEST_TEAM_NAME);
    }),
  );

  // --- Tools ---

  it.effect("register and list tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();

      // Register tools via the underlying registry (plugins do this)
      const config = makePgConfig(db, {
        teamId: TEST_TEAM_ID,
        teamName: TEST_TEAM_NAME,
        encryptionKey: TEST_ENCRYPTION_KEY,
      });
      yield* config.tools.register([
        new ToolRegistration({
          id: ToolId.make("t1"),
          pluginKey: "test",
          sourceId: "src-a",
          name: "tool-one",
          description: "First tool",
        }),
        new ToolRegistration({
          id: ToolId.make("t2"),
          pluginKey: "test",
          sourceId: "src-b",
          name: "tool-two",
        }),
      ]);

      const all = yield* executor.tools.list();
      expect(all).toHaveLength(2);

      const filtered = yield* executor.tools.list({ sourceId: "src-a" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.name).toBe("tool-one");
    }),
  );

  it.effect("query filter on tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const config = makePgConfig(db, {
        teamId: TEST_TEAM_ID,
        teamName: TEST_TEAM_NAME,
        encryptionKey: TEST_ENCRYPTION_KEY,
      });
      yield* config.tools.register([
        new ToolRegistration({
          id: ToolId.make("a"),
          pluginKey: "test",
          sourceId: "test-src",
          name: "create-user",
          description: "Creates a user",
        }),
        new ToolRegistration({
          id: ToolId.make("b"),
          pluginKey: "test",
          sourceId: "test-src",
          name: "delete-user",
        }),
      ]);

      const results = yield* executor.tools.list({ query: "creates" });
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("create-user");
    }),
  );

  // --- Secrets ---

  it.effect("set and resolve secrets", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.secrets.set({
        id: SecretId.make("api-key"),
        name: "API Key",
        value: "sk-12345",
        purpose: "auth",
      });

      const resolved = yield* executor.secrets.resolve(SecretId.make("api-key"));
      expect(resolved).toBe("sk-12345");
    }),
  );

  it.effect("list and remove secrets", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.secrets.set({
        id: SecretId.make("rm-me"),
        name: "Removable",
        value: "val",
      });

      const listed = yield* executor.secrets.list();
      expect(listed).toHaveLength(1);

      yield* executor.secrets.remove(SecretId.make("rm-me"));
      expect(yield* executor.secrets.list()).toHaveLength(0);
    }),
  );

  it.effect("secret status check", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();

      const missing = yield* executor.secrets.status(SecretId.make("no-exist"));
      expect(missing).toBe("missing");

      yield* executor.secrets.set({
        id: SecretId.make("exists"),
        name: "Exists",
        value: "v",
      });
      const resolved = yield* executor.secrets.status(SecretId.make("exists"));
      expect(resolved).toBe("resolved");
    }),
  );

  it.effect("encryption with wrong key fails to resolve", () =>
    Effect.gen(function* () {
      const executor1 = yield* makeTestExecutorForTeam(TEST_TEAM_ID, TEST_TEAM_NAME);
      yield* executor1.secrets.set({
        id: SecretId.make("enc-test"),
        name: "Encrypted",
        value: "secret-value",
      });

      // Create executor with different encryption key
      const config2 = makePgConfig(db, {
        teamId: TEST_TEAM_ID,
        teamName: TEST_TEAM_NAME,
        encryptionKey: "wrong-key",
      });
      const executor2 = yield* createExecutor(config2);

      const result = yield* executor2.secrets.resolve(SecretId.make("enc-test")).pipe(
        Effect.either,
      );
      expect(result._tag).toBe("Left");
    }),
  );

  // --- Policies ---

  it.effect("add and list policies", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const policy = yield* executor.policies.add({
        scopeId: ScopeId.make(TEST_TEAM_ID),
        name: "allow-t1",
        action: "allow" as const,
        match: { toolPattern: "t1" },
        priority: 0,
      });

      expect(policy.id).toBeDefined();
      const listed = yield* executor.policies.list();
      expect(listed).toHaveLength(1);
    }),
  );

  it.effect("remove policies", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const policy = yield* executor.policies.add({
        scopeId: ScopeId.make(TEST_TEAM_ID),
        name: "allow-t1",
        action: "allow" as const,
        match: { toolPattern: "t1" },
        priority: 0,
      });

      expect(yield* executor.policies.remove(policy.id)).toBe(true);
      expect(yield* executor.policies.list()).toHaveLength(0);
    }),
  );

  // --- Team isolation ---

  it.effect("team isolation — tools", () =>
    Effect.gen(function* () {
      const configA = makePgConfig(db, { teamId: "team-a", teamName: "Team A", encryptionKey: TEST_ENCRYPTION_KEY });
      const configB = makePgConfig(db, { teamId: "team-b", teamName: "Team B", encryptionKey: TEST_ENCRYPTION_KEY });

      yield* configA.tools.register([
        new ToolRegistration({ id: ToolId.make("t1"), pluginKey: "test", sourceId: "src", name: "team-a-tool" }),
      ]);
      yield* configB.tools.register([
        new ToolRegistration({ id: ToolId.make("t1"), pluginKey: "test", sourceId: "src", name: "team-b-tool" }),
      ]);

      const executorA = yield* createExecutor(configA);
      const executorB = yield* createExecutor(configB);

      const aTools = yield* executorA.tools.list();
      expect(aTools).toHaveLength(1);
      expect(aTools[0]!.name).toBe("team-a-tool");

      const bTools = yield* executorB.tools.list();
      expect(bTools).toHaveLength(1);
      expect(bTools[0]!.name).toBe("team-b-tool");
    }),
  );

  it.effect("team isolation — secrets", () =>
    Effect.gen(function* () {
      const executorA = yield* makeTestExecutorForTeam("team-a", "Team A");
      const executorB = yield* makeTestExecutorForTeam("team-b", "Team B");

      yield* executorA.secrets.set({
        id: SecretId.make("shared-id"),
        name: "Team A Secret",
        value: "a-value",
      });
      yield* executorB.secrets.set({
        id: SecretId.make("shared-id"),
        name: "Team B Secret",
        value: "b-value",
      });

      expect(yield* executorA.secrets.resolve(SecretId.make("shared-id"))).toBe("a-value");
      expect(yield* executorB.secrets.resolve(SecretId.make("shared-id"))).toBe("b-value");
    }),
  );

  // --- Plugin KV (escape hatch) ---

  it.effect("plugin KV works via scopeKv", () =>
    Effect.gen(function* () {
      const kv = makePgKv(db, TEST_TEAM_ID);
      const scoped = scopeKv(kv, "my-plugin");

      yield* scoped.set("k1", "v1");
      expect(yield* scoped.get("k1")).toBe("v1");

      const items = yield* scoped.list();
      expect(items).toHaveLength(1);

      yield* scoped.delete("k1");
      expect(yield* scoped.get("k1")).toBeNull();
    }),
  );

  it.effect("plugin KV team isolation", () =>
    Effect.gen(function* () {
      const kv1 = makePgKv(db, "team-a");
      const kv2 = makePgKv(db, "team-b");

      yield* kv1.set("ns", "key", "team-a-value");
      yield* kv2.set("ns", "key", "team-b-value");

      expect(yield* kv1.get("ns", "key")).toBe("team-a-value");
      expect(yield* kv2.get("ns", "key")).toBe("team-b-value");
    }),
  );

  // --- Close ---

  it.effect("executor closes cleanly", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.close();
    }),
  );
});

// ---------------------------------------------------------------------------
// User Store (not part of Executor, tested directly)
// ---------------------------------------------------------------------------

describe("UserStore", () => {
  it("upsert and get user", async () => {
    const store = makeUserStore(db);
    const user = await store.upsertUser({
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    });
    expect(user.id).toBe("user-1");

    const fetched = await store.getUser("user-1");
    expect(fetched!.name).toBe("Test User");

    await store.upsertUser({ id: "user-1", email: "test@example.com", name: "Updated" });
    expect((await store.getUser("user-1"))!.name).toBe("Updated");
  });

  it("create team and manage members", async () => {
    const store = makeUserStore(db);
    await store.upsertUser({ id: "u1", email: "a@example.com", name: "A" });
    await store.upsertUser({ id: "u2", email: "b@example.com", name: "B" });

    const team = await store.createTeam("My Team");
    await store.addMember(team.id, "u1", "owner");
    await store.addMember(team.id, "u2", "member");

    expect(await store.listMembers(team.id)).toHaveLength(2);

    const teams = await store.getTeamsForUser("u1");
    expect(teams[0]!.teamName).toBe("My Team");

    await store.removeMember(team.id, "u2");
    expect(await store.listMembers(team.id)).toHaveLength(1);
  });

  it("invitations workflow", async () => {
    const store = makeUserStore(db);
    await store.upsertUser({ id: "u1", email: "owner@example.com" });
    const team = await store.createTeam("Team");
    await store.addMember(team.id, "u1", "owner");

    const invitation = await store.createInvitation(team.id, "new@example.com", "u1");
    expect(invitation.status).toBe("pending");
    expect(await store.getPendingInvitations("new@example.com")).toHaveLength(1);

    await store.acceptInvitation(invitation.id);
    expect(await store.getPendingInvitations("new@example.com")).toHaveLength(0);
  });

});
