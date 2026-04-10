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
} from "@executor/sdk";

import { makePgConfig } from "./index";
import { makePgKv } from "./pg-kv";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Test setup — in-memory Postgres via PGlite + Drizzle migrations
// ---------------------------------------------------------------------------

const TEST_ORG_ID = "test-org-1";
const TEST_ORG_NAME = "Test Org";
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
  await db.execute(sql`TRUNCATE plugin_kv, policies, secrets, tool_definitions, tools, sources`);
});

afterAll(async () => {
  await client.close();
});

// ---------------------------------------------------------------------------
// Helper — create executor from PgConfig
// ---------------------------------------------------------------------------

const makeTestExecutor = () => {
  const config = makePgConfig(db, {
    organizationId: TEST_ORG_ID,
    organizationName: TEST_ORG_NAME,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  return createExecutor(config);
};

const makeTestExecutorForOrg = (organizationId: string, organizationName: string) => {
  const config = makePgConfig(db, {
    organizationId,
    organizationName,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  return createExecutor(config);
};

// ---------------------------------------------------------------------------
// Executor via makePgConfig
// ---------------------------------------------------------------------------

describe("Executor with Postgres storage", () => {
  it.effect("scope reflects organization", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      expect(executor.scope.id).toBe(TEST_ORG_ID);
      expect(executor.scope.name).toBe(TEST_ORG_NAME);
    }),
  );

  // --- Tools ---

  it.effect("register and list tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();

      // Register tools via the underlying registry (plugins do this)
      const config = makePgConfig(db, {
        organizationId: TEST_ORG_ID,
        organizationName: TEST_ORG_NAME,
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
        organizationId: TEST_ORG_ID,
        organizationName: TEST_ORG_NAME,
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
      const executor1 = yield* makeTestExecutorForOrg(TEST_ORG_ID, TEST_ORG_NAME);
      yield* executor1.secrets.set({
        id: SecretId.make("enc-test"),
        name: "Encrypted",
        value: "secret-value",
      });

      // Create executor with different encryption key
      const config2 = makePgConfig(db, {
        organizationId: TEST_ORG_ID,
        organizationName: TEST_ORG_NAME,
        encryptionKey: "wrong-key",
      });
      const executor2 = yield* createExecutor(config2);

      const result = yield* executor2.secrets
        .resolve(SecretId.make("enc-test"))
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  );

  // --- Policies ---

  it.effect("add and list policies", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const policy = yield* executor.policies.add({
        scopeId: ScopeId.make(TEST_ORG_ID),
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
        scopeId: ScopeId.make(TEST_ORG_ID),
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

  it.effect("organization isolation — tools", () =>
    Effect.gen(function* () {
      const configA = makePgConfig(db, {
        organizationId: "org-a",
        organizationName: "Org A",
        encryptionKey: TEST_ENCRYPTION_KEY,
      });
      const configB = makePgConfig(db, {
        organizationId: "org-b",
        organizationName: "Org B",
        encryptionKey: TEST_ENCRYPTION_KEY,
      });

      yield* configA.tools.register([
        new ToolRegistration({
          id: ToolId.make("t1"),
          pluginKey: "test",
          sourceId: "src",
          name: "org-a-tool",
        }),
      ]);
      yield* configB.tools.register([
        new ToolRegistration({
          id: ToolId.make("t1"),
          pluginKey: "test",
          sourceId: "src",
          name: "org-b-tool",
        }),
      ]);

      const executorA = yield* createExecutor(configA);
      const executorB = yield* createExecutor(configB);

      const aTools = yield* executorA.tools.list();
      expect(aTools).toHaveLength(1);
      expect(aTools[0]!.name).toBe("org-a-tool");

      const bTools = yield* executorB.tools.list();
      expect(bTools).toHaveLength(1);
      expect(bTools[0]!.name).toBe("org-b-tool");
    }),
  );

  it.effect("organization isolation — secrets", () =>
    Effect.gen(function* () {
      const executorA = yield* makeTestExecutorForOrg("org-a", "Org A");
      const executorB = yield* makeTestExecutorForOrg("org-b", "Org B");

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
      const kv = makePgKv(db, TEST_ORG_ID);
      const scoped = scopeKv(kv, "my-plugin");

      yield* scoped.set([{ key: "k1", value: "v1" }]);
      expect(yield* scoped.get("k1")).toBe("v1");

      const items = yield* scoped.list();
      expect(items).toHaveLength(1);

      yield* scoped.delete(["k1"]);
      expect(yield* scoped.get("k1")).toBeNull();
    }),
  );

  it.effect("plugin KV organization isolation", () =>
    Effect.gen(function* () {
      const kv1 = makePgKv(db, "org-a");
      const kv2 = makePgKv(db, "org-b");

      yield* kv1.set("ns", [{ key: "key", value: "org-a-value" }]);
      yield* kv2.set("ns", [{ key: "key", value: "org-b-value" }]);

      expect(yield* kv1.get("ns", "key")).toBe("org-a-value");
      expect(yield* kv2.get("ns", "key")).toBe("org-b-value");
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
