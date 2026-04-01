import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SqlClient from "@effect/sql/SqlClient";

import { ScopeId, ToolId, SecretId, makeInMemorySecretProvider, scopeKv } from "@executor/sdk";
import type { Kv } from "@executor/sdk";
import { migrate } from "./schema";
import { makeSqliteKv } from "./plugin-kv";
import { makeKvToolRegistry } from "./tool-registry";
import { makeKvSecretStore } from "./secret-store";
import { makeKvPolicyEngine } from "./policy-engine";

// ---------------------------------------------------------------------------
// Test layer: in-memory SQLite + migrated KV
// ---------------------------------------------------------------------------

const TestSqlLayer = SqliteClient.layer({ filename: ":memory:" });

const withKv = <A, E>(
  fn: (kv: Kv) => Effect.Effect<A, E>,
) =>
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

  it.effect("shared definitions and $ref reattachment", () =>
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
        const input = schema.inputSchema as Record<string, unknown>;
        expect(input.$defs).toBeDefined();
        expect((input.$defs as Record<string, unknown>).Address).toBeDefined();
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
          { id: ToolId.make("a"), pluginKey: "test", sourceId: "test-src", name: "create-user", description: "Creates a user" },
          { id: ToolId.make("b"), pluginKey: "test", sourceId: "test-src", name: "delete-user" },
        ]);

        const results = yield* reg.list({ query: "creates" });
        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("create-user");
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

        const resolved = yield* store.resolve(
          SecretId.make("api-key"),
          ScopeId.make("s1"),
        );
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
