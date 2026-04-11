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
import { makePgExecutionStore } from "./execution-store";
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
  await db.execute(
    sql`TRUNCATE execution_interactions, executions, plugin_kv, policies, secrets, tool_definitions, tools, sources`,
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

type CreateExecutionInputBuilder = Parameters<
  ReturnType<typeof makePgExecutionStore>["create"]
>[0];

const makePgExecutionInput = (
  overrides: Partial<CreateExecutionInputBuilder>,
): CreateExecutionInputBuilder => ({
  scopeId: ScopeId.make("test"),
  status: "completed",
  code: "return 1",
  resultJson: null,
  errorText: null,
  logsJson: null,
  startedAt: null,
  completedAt: null,
  triggerKind: null,
  triggerMetaJson: null,
  toolCallCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe("PostgresExecutionStore", () => {
  it.effect("lists scoped executions with filters and pending interactions", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const now = Date.now();

      const first = yield* store.create(
        makePgExecutionInput({
          scopeId,
          status: "completed",
          code: "return 1",
          resultJson: "1",
          startedAt: now - 20,
          completedAt: now - 10,
          triggerKind: "http",
          createdAt: now - 20,
          updatedAt: now - 10,
        }),
      );
      const second = yield* store.create(
        makePgExecutionInput({
          scopeId,
          status: "waiting_for_interaction",
          code: "return await tools.api.singleApproval({})",
          startedAt: now,
          triggerKind: "mcp",
          createdAt: now,
          updatedAt: now,
        }),
      );

      yield* store.recordInteraction(second.id, {
        executionId: second.id,
        status: "pending",
        kind: "form",
        purpose: "Approval required",
        payloadJson: "{}",
        responseJson: null,
        responsePrivateJson: null,
        createdAt: now,
        updatedAt: now,
      });

      const filtered = yield* store.list(scopeId, {
        limit: 1,
        statusFilter: ["waiting_for_interaction"],
        codeQuery: "singleApproval",
      });
      expect(filtered.executions).toHaveLength(1);
      expect(filtered.executions[0]?.id).toBe(second.id);
      expect(filtered.executions[0]?.pendingInteraction?.purpose).toBe("Approval required");

      const firstPage = yield* store.list(scopeId, {
        limit: 1,
      });
      expect(firstPage.executions[0]?.id).toBe(second.id);

      const pageTwo = yield* store.list(scopeId, {
        limit: 1,
        cursor: firstPage.nextCursor,
      });
      expect(pageTwo.executions).toHaveLength(1);
      expect(pageTwo.executions[0]?.id).toBe(first.id);
    }),
  );

  it.effect("filters by triggerKind and populates triggerCounts in meta", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const now = Date.now();

      yield* store.create(makePgExecutionInput({ scopeId, triggerKind: "http", createdAt: now - 30 }));
      yield* store.create(makePgExecutionInput({ scopeId, triggerKind: "http", createdAt: now - 20 }));
      yield* store.create(
        makePgExecutionInput({ scopeId, triggerKind: "mcp", createdAt: now - 10 }),
      );
      yield* store.create(makePgExecutionInput({ scopeId, triggerKind: null, createdAt: now }));

      const httpOnly = yield* store.list(scopeId, {
        limit: 10,
        triggerFilter: ["http"],
      });
      expect(httpOnly.executions).toHaveLength(2);

      const unknownOnly = yield* store.list(scopeId, {
        limit: 10,
        triggerFilter: ["unknown"],
      });
      expect(unknownOnly.executions).toHaveLength(1);

      const all = yield* store.list(scopeId, { limit: 10, includeMeta: true });
      expect(all.meta?.triggerCounts.http).toBe(2);
      expect(all.meta?.triggerCounts.mcp).toBe(1);
      expect(all.meta?.triggerCounts.unknown).toBe(1);
    }),
  );

  it.effect("filters by hadElicitation and populates interactionCounts", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-elicit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const now = Date.now();

      const elicited = yield* store.create(
        makePgExecutionInput({ scopeId, triggerKind: "mcp", createdAt: now - 20 }),
      );
      yield* store.create(
        makePgExecutionInput({ scopeId, triggerKind: "mcp", createdAt: now - 10 }),
      );

      // Record an interaction only on the first run.
      yield* store.recordInteraction(elicited.id, {
        executionId: elicited.id,
        status: "resolved",
        kind: "form",
        purpose: "Confirm action",
        payloadJson: "{}",
        responseJson: null,
        responsePrivateJson: null,
        createdAt: now - 20,
        updatedAt: now - 15,
      });

      const withElicit = yield* store.list(scopeId, {
        limit: 10,
        hadElicitation: true,
      });
      expect(withElicit.executions).toHaveLength(1);
      expect(withElicit.executions[0]?.id).toBe(elicited.id);

      const withoutElicit = yield* store.list(scopeId, {
        limit: 10,
        hadElicitation: false,
      });
      expect(withoutElicit.executions).toHaveLength(1);
      expect(withoutElicit.executions[0]?.id).not.toBe(elicited.id);

      const all = yield* store.list(scopeId, { limit: 10, includeMeta: true });
      expect(all.meta?.interactionCounts.withElicitation).toBe(1);
      expect(all.meta?.interactionCounts.withoutElicitation).toBe(1);
    }),
  );

  it.effect("records tool calls, lists them, and populates toolFacets", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const now = Date.now();

      const execution = yield* store.create(
        makePgExecutionInput({
          scopeId,
          code: "return await tools.github.listIssues({})",
          triggerKind: "http",
          createdAt: now,
        }),
      );

      const call1 = yield* store.recordToolCall({
        executionId: execution.id,
        status: "running",
        toolPath: "github.listIssues",
        namespace: "github",
        argsJson: "{}",
        resultJson: null,
        errorText: null,
        startedAt: now,
        completedAt: null,
        durationMs: null,
      });

      yield* store.finishToolCall(call1.id, {
        status: "completed",
        resultJson: "[]",
        errorText: null,
        completedAt: now + 50,
        durationMs: 50,
      });

      yield* store.recordToolCall({
        executionId: execution.id,
        status: "completed",
        toolPath: "github.getIssue",
        namespace: "github",
        argsJson: "{}",
        resultJson: null,
        errorText: null,
        startedAt: now + 10,
        completedAt: now + 30,
        durationMs: 20,
      });

      const calls = yield* store.listToolCalls(execution.id);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.toolPath).toBe("github.listIssues");
      expect(calls[0]?.status).toBe("completed");
      expect(calls[0]?.durationMs).toBe(50);
      expect(calls[1]?.toolPath).toBe("github.getIssue");

      const listed = yield* store.list(scopeId, { limit: 10, includeMeta: true });
      const facetMap = Object.fromEntries(
        (listed.meta?.toolFacets ?? []).map((facet) => [facet.toolPath, facet.count]),
      );
      expect(facetMap["github.listIssues"]).toBe(1);
      expect(facetMap["github.getIssue"]).toBe(1);

      const glob = yield* store.list(scopeId, {
        limit: 10,
        toolPathFilter: ["github.*"],
      });
      expect(glob.executions).toHaveLength(1);

      const exact = yield* store.list(scopeId, {
        limit: 10,
        toolPathFilter: ["github.listIssues"],
      });
      expect(exact.executions).toHaveLength(1);

      const miss = yield* store.list(scopeId, {
        limit: 10,
        toolPathFilter: ["stripe.*"],
      });
      expect(miss.executions).toHaveLength(0);
    }),
  );

  it.effect("after cursor returns only rows newer than the given timestamp", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-after-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const base = Date.now();

      yield* store.create(makePgExecutionInput({ scopeId, createdAt: base - 100 }));
      yield* store.create(makePgExecutionInput({ scopeId, createdAt: base - 50 }));
      yield* store.create(makePgExecutionInput({ scopeId, createdAt: base }));

      const afterResult = yield* store.list(scopeId, { limit: 10, after: base - 60 });
      expect(afterResult.executions).toHaveLength(2);
      expect(afterResult.executions.every((e) => e.createdAt > base - 60)).toBe(true);
    }),
  );

  it.effect("sort option controls list order by createdAt and durationMs", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-sort-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const now = Date.now();

      // Three executions: oldest+longest, middle+shortest, newest+nulldur.
      const oldLong = yield* store.create(
        makePgExecutionInput({
          scopeId,
          createdAt: now - 300,
          startedAt: now - 300,
          completedAt: now - 200, // duration = 100
        }),
      );
      const midShort = yield* store.create(
        makePgExecutionInput({
          scopeId,
          createdAt: now - 200,
          startedAt: now - 200,
          completedAt: now - 190, // duration = 10
        }),
      );
      const newNull = yield* store.create(
        makePgExecutionInput({
          scopeId,
          createdAt: now - 100,
          startedAt: null,
          completedAt: null,
        }),
      );

      // Default sort (createdAt desc) — newest first
      const defaultSort = yield* store.list(scopeId, { limit: 10 });
      expect(defaultSort.executions.map((e) => e.id)).toEqual([
        newNull.id,
        midShort.id,
        oldLong.id,
      ]);

      // createdAt asc — oldest first
      const createdAtAsc = yield* store.list(scopeId, {
        limit: 10,
        sort: { field: "createdAt", direction: "asc" },
      });
      expect(createdAtAsc.executions.map((e) => e.id)).toEqual([
        oldLong.id,
        midShort.id,
        newNull.id,
      ]);

      // durationMs desc — longest first, null to the end
      const durDesc = yield* store.list(scopeId, {
        limit: 10,
        sort: { field: "durationMs", direction: "desc" },
      });
      expect(durDesc.executions.map((e) => e.id)).toEqual([
        oldLong.id,
        midShort.id,
        newNull.id,
      ]);

      // durationMs asc — shortest first, null still to the end
      const durAsc = yield* store.list(scopeId, {
        limit: 10,
        sort: { field: "durationMs", direction: "asc" },
      });
      expect(durAsc.executions.map((e) => e.id)).toEqual([
        midShort.id,
        oldLong.id,
        newNull.id,
      ]);
    }),
  );

  it.effect("sweeps expired executions, their interactions, and tool calls", () =>
    Effect.gen(function* () {
      const store = makePgExecutionStore(db, TEST_ORG_ID);
      const scopeId = ScopeId.make(
        `${TEST_ORG_ID}-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const expiredAt = Date.now() - 31 * 24 * 60 * 60 * 1000;

      const expired = yield* store.create(
        makePgExecutionInput({
          scopeId,
          status: "failed",
          code: "throw new Error('boom')",
          errorText: "boom",
          startedAt: expiredAt,
          completedAt: expiredAt,
          createdAt: expiredAt,
          updatedAt: expiredAt,
        }),
      );

      yield* store.recordInteraction(expired.id, {
        executionId: expired.id,
        status: "pending",
        kind: "form",
        purpose: "Expired interaction",
        payloadJson: "{}",
        responseJson: null,
        responsePrivateJson: null,
        createdAt: expiredAt,
        updatedAt: expiredAt,
      });

      yield* store.recordToolCall({
        executionId: expired.id,
        status: "completed",
        toolPath: "github.listIssues",
        namespace: "github",
        argsJson: null,
        resultJson: null,
        errorText: null,
        startedAt: expiredAt,
        completedAt: expiredAt + 1,
        durationMs: 1,
      });

      yield* store.sweep();

      const result = yield* store.get(expired.id);
      expect(result).toBeNull();
      const calls = yield* store.listToolCalls(expired.id);
      expect(calls).toHaveLength(0);
    }),
  );
});
