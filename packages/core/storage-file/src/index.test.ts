import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SqlClient from "@effect/sql/SqlClient";

import {
  ScopeId,
  ToolId,
  SecretId,
  makeInMemorySecretProvider,
  scopeKv,
} from "@executor/sdk";
import type { Kv } from "@executor/sdk";
import { migrate } from "./schema";
import { makeSqliteKv } from "./plugin-kv";
import { makeKvToolRegistry } from "./tool-registry";
import { makeKvSecretStore } from "./secret-store";
import { makeKvPolicyEngine } from "./policy-engine";
import { makeSqliteExecutionStore } from "./execution-store";

// ---------------------------------------------------------------------------
// Test layer: in-memory SQLite + migrated KV
// ---------------------------------------------------------------------------

const TestSqlLayer = SqliteClient.layer({ filename: ":memory:" });

const withKv = <A, E>(fn: (kv: Kv) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
    const kv = makeSqliteKv(sql);
    return yield* fn(kv);
  }).pipe(Effect.provide(TestSqlLayer));

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

describe("KvToolRegistry", () => {
  it.effect("register and list tools", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const reg = makeKvToolRegistry(scopeKv(kv, "tools"), scopeKv(kv, "defs"));
        yield* reg.register([
          {
            id: ToolId.make("t1"),
            pluginKey: "test",
            sourceId: "src-a",
            name: "tool-one",
            description: "First tool",
          },
          {
            id: ToolId.make("t2"),
            pluginKey: "test",
            sourceId: "src-b",
            name: "tool-two",
          },
        ]);

        const all = yield* reg.list();
        expect(all).toHaveLength(2);

        const filtered = yield* reg.list({ sourceId: "src-a" });
        expect(filtered).toHaveLength(1);
        expect(filtered[0]!.name).toBe("tool-one");
      }),
    ),
  );

  it.effect("shared definitions are reused in TypeScript previews", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const reg = makeKvToolRegistry(scopeKv(kv, "tools"), scopeKv(kv, "defs"));
        yield* reg.registerDefinitions({
          Address: { type: "object", properties: { city: { type: "string" } } },
        });

        yield* reg.register([
          {
            id: ToolId.make("with-ref"),
            pluginKey: "test",
            sourceId: "test-src",
            name: "with-ref",
            inputSchema: {
              type: "object",
              properties: { addr: { $ref: "#/$defs/Address" } },
            },
          },
        ]);

        const schema = yield* reg.schema(ToolId.make("with-ref"));
        expect(schema.inputTypeScript).toBe("{ addr?: Address }");
        expect(schema.typeScriptDefinitions).toEqual({
          Address: "{ city?: string }",
        });
      }),
    ),
  );

  it.effect("unregister tools", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const reg = makeKvToolRegistry(scopeKv(kv, "tools"), scopeKv(kv, "defs"));
        yield* reg.register([
          { id: ToolId.make("del-me"), pluginKey: "test", sourceId: "test-src", name: "delete-me" },
        ]);
        expect(yield* reg.list()).toHaveLength(1);

        yield* reg.unregister([ToolId.make("del-me")]);
        expect(yield* reg.list()).toHaveLength(0);
      }),
    ),
  );

  it.effect("query filter", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const reg = makeKvToolRegistry(scopeKv(kv, "tools"), scopeKv(kv, "defs"));
        yield* reg.register([
          {
            id: ToolId.make("a"),
            pluginKey: "test",
            sourceId: "test-src",
            name: "create-user",
            description: "Creates a user",
          },
          { id: ToolId.make("b"), pluginKey: "test", sourceId: "test-src", name: "delete-user" },
        ]);

        const results = yield* reg.list({ query: "creates" });
        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("create-user");
      }),
    ),
  );

  it.effect("runtime tools are listed but not persisted", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const reg1 = makeKvToolRegistry(scopeKv(kv, "tools"), scopeKv(kv, "defs"));
        yield* reg1.registerRuntime([
          {
            id: ToolId.make("executor.test.runtime"),
            pluginKey: "test",
            sourceId: "executor.test",
            name: "runtime",
            description: "Runtime-only tool",
          },
        ]);

        const listed = yield* reg1.list();
        expect(listed.map((tool) => tool.id)).toContain("executor.test.runtime");

        const reg2 = makeKvToolRegistry(scopeKv(kv, "tools"), scopeKv(kv, "defs"));
        const relisted = yield* reg2.list();
        expect(relisted.map((tool) => tool.id)).not.toContain("executor.test.runtime");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Secret store
// ---------------------------------------------------------------------------

describe("KvSecretStore", () => {
  it.effect("set and resolve secrets", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const store = makeKvSecretStore(scopeKv(kv, "secrets"));
        yield* store.addProvider(makeInMemorySecretProvider());
        yield* store.set({
          scopeId: ScopeId.make("s1"),
          id: SecretId.make("api-key"),
          name: "API Key",
          value: "sk-12345",
          purpose: "auth",
        });

        const resolved = yield* store.resolve(SecretId.make("api-key"), ScopeId.make("s1"));
        expect(resolved).toBe("sk-12345");
      }),
    ),
  );

  it.effect("list and remove", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const store = makeKvSecretStore(scopeKv(kv, "secrets"));
        yield* store.addProvider(makeInMemorySecretProvider());
        yield* store.set({
          scopeId: ScopeId.make("s1"),
          id: SecretId.make("rm-me"),
          name: "Removable",
          value: "val",
        });

        const listed = yield* store.list(ScopeId.make("s1"));
        expect(listed).toHaveLength(1);

        yield* store.remove(SecretId.make("rm-me"));
        expect(yield* store.list(ScopeId.make("s1"))).toHaveLength(0);
      }),
    ),
  );

  it.effect("status check", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const store = makeKvSecretStore(scopeKv(kv, "secrets"));
        yield* store.addProvider(makeInMemorySecretProvider());
        const missing = yield* store.status(SecretId.make("no-exist"), ScopeId.make("s1"));
        expect(missing).toBe("missing");

        yield* store.set({
          scopeId: ScopeId.make("s1"),
          id: SecretId.make("exists"),
          name: "Exists",
          value: "v",
        });
        const resolved = yield* store.status(SecretId.make("exists"), ScopeId.make("s1"));
        expect(resolved).toBe("resolved");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

describe("KvPolicyEngine", () => {
  it.effect("add and list policies", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const engine = makeKvPolicyEngine(scopeKv(kv, "policies"), scopeKv(kv, "meta"));
        const policy = yield* engine.add({
          scopeId: ScopeId.make("s1"),
          name: "allow-t1",
          action: "allow" as const,
          match: { toolPattern: "t1" },
          priority: 0,
        });

        expect(policy.id).toBeDefined();
        const listed = yield* engine.list(ScopeId.make("s1"));
        expect(listed).toHaveLength(1);
      }),
    ),
  );

  it.effect("remove policies", () =>
    withKv((kv) =>
      Effect.gen(function* () {
        const engine = makeKvPolicyEngine(scopeKv(kv, "policies"), scopeKv(kv, "meta"));
        const policy = yield* engine.add({
          scopeId: ScopeId.make("s1"),
          name: "allow-t1",
          action: "allow" as const,
          match: { toolPattern: "t1" },
          priority: 0,
        });

        expect(yield* engine.remove(policy.id)).toBe(true);
        expect(yield* engine.list(ScopeId.make("s1"))).toHaveLength(0);
      }),
    ),
  );
});

type CreateExecutionInputBuilder = Parameters<
  ReturnType<typeof makeSqliteExecutionStore>["create"]
>[0];

const makeExecutionInput = (
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

describe("SqliteExecutionStore", () => {
  it.effect("lists scoped executions with filters and pending interactions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = Date.now();

      const first = yield* store.create(
        makeExecutionInput({
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
        makeExecutionInput({
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
    }).pipe(Effect.provide(TestSqlLayer)),
  );

  it.effect("filters by triggerKind and populates triggerCounts in meta", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = Date.now();

      yield* store.create(makeExecutionInput({ scopeId, triggerKind: "http", createdAt: now - 30 }));
      yield* store.create(makeExecutionInput({ scopeId, triggerKind: "http", createdAt: now - 20 }));
      yield* store.create(makeExecutionInput({ scopeId, triggerKind: "mcp", createdAt: now - 10 }));
      yield* store.create(makeExecutionInput({ scopeId, triggerKind: null, createdAt: now }));

      const httpOnly = yield* store.list(scopeId, {
        limit: 10,
        triggerFilter: ["http"],
        includeMeta: true,
      });
      expect(httpOnly.executions).toHaveLength(2);

      const all = yield* store.list(scopeId, { limit: 10, includeMeta: true });
      expect(all.meta?.triggerCounts.http).toBe(2);
      expect(all.meta?.triggerCounts.mcp).toBe(1);
      expect(all.meta?.triggerCounts.unknown).toBe(1);
    }).pipe(Effect.provide(TestSqlLayer)),
  );

  it.effect("filters by hadElicitation and populates interactionCounts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = Date.now();

      const elicited = yield* store.create(
        makeExecutionInput({ scopeId, triggerKind: "mcp", createdAt: now - 20 }),
      );
      yield* store.create(
        makeExecutionInput({ scopeId, triggerKind: "mcp", createdAt: now - 10 }),
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
    }).pipe(Effect.provide(TestSqlLayer)),
  );

  it.effect("records tool calls, lists them, and populates toolFacets", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = Date.now();

      const execution = yield* store.create(
        makeExecutionInput({
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
      expect(listed.meta?.toolFacets).toHaveLength(2);
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
    }).pipe(Effect.provide(TestSqlLayer)),
  );

  it.effect("after cursor returns only rows newer than the given timestamp", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const base = Date.now();

      yield* store.create(makeExecutionInput({ scopeId, createdAt: base - 100 }));
      yield* store.create(makeExecutionInput({ scopeId, createdAt: base - 50 }));
      yield* store.create(makeExecutionInput({ scopeId, createdAt: base }));

      const afterResult = yield* store.list(scopeId, { limit: 10, after: base - 60 });
      expect(afterResult.executions).toHaveLength(2);
      expect(afterResult.executions.every((e) => e.createdAt > base - 60)).toBe(true);
    }).pipe(Effect.provide(TestSqlLayer)),
  );

  it.effect("sort option controls list order by createdAt and durationMs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = Date.now();

      // Three executions: oldest+longest, middle+shortest, newest+nulldur.
      const oldLong = yield* store.create(
        makeExecutionInput({
          scopeId,
          createdAt: now - 300,
          startedAt: now - 300,
          completedAt: now - 200,  // duration = 100
        }),
      );
      const midShort = yield* store.create(
        makeExecutionInput({
          scopeId,
          createdAt: now - 200,
          startedAt: now - 200,
          completedAt: now - 190,  // duration = 10
        }),
      );
      const newNull = yield* store.create(
        makeExecutionInput({
          scopeId,
          createdAt: now - 100,
          startedAt: null,
          completedAt: null,  // duration = null
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
    }).pipe(Effect.provide(TestSqlLayer)),
  );

  it.effect("sweeps expired executions, their interactions, and tool calls", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));
      const store = makeSqliteExecutionStore(sql);
      const scopeId = ScopeId.make(`scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const expiredAt = Date.now() - 31 * 24 * 60 * 60 * 1000;

      const expired = yield* store.create(
        makeExecutionInput({
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
    }).pipe(Effect.provide(TestSqlLayer)),
  );
});
