import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import { collectSchemas, createExecutor } from "./executor";
import { SecretId } from "./ids";
import { definePlugin } from "./plugin";
import { SetSecretInput } from "./secrets";
import type { SecretProvider } from "./secrets";
import { ScopeStack } from "./scope";
import { makeLayeredTestConfig, makeTestScope } from "./testing";

// ---------------------------------------------------------------------------
// Shared in-memory provider. All executors under test share one backing
// Map. Concretely this is what a single-tenant vault (one shared backend
// across scopes) looks like. Per-scope isolation in these tests comes
// from the core `secret` routing table carrying `scope_id`, not from
// provider keyspaces — that's a provider-design concern layered on top
// and not what the executor's shadowing logic is trying to own.
// ---------------------------------------------------------------------------

const makeSharedProvider = (store: Map<string, string>): SecretProvider => ({
  key: "memory",
  writable: true,
  get: (id) => Effect.sync(() => store.get(id) ?? null),
  set: (id, value) =>
    Effect.sync(() => {
      store.set(id, value);
    }),
  delete: (id) => Effect.sync(() => store.delete(id)),
  list: () =>
    Effect.sync(() =>
      Array.from(store.keys()).map((id) => ({ id, name: id })),
    ),
});

const sharedSecretsPlugin = (store: Map<string, string>) =>
  definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [makeSharedProvider(store)],
  }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("layered scope: secrets metadata shadowing", () => {
  it.effect("single-scope read falls back to org default via shared routing", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A", "Alice");
      const org = makeTestScope("org-1", "Acme");

      const schema = collectSchemas([sharedSecretsPlugin(new Map())()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const store = new Map<string, string>();
      const backing = { adapter, blobs };

      // Org writes the shared default first.
      const orgExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );
      yield* orgExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          name: "API Token (org)",
          value: "org-value",
        }),
      );

      // User-first chain. No user row → shadowByKey picks the org row →
      // provider returns the shared value.
      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );

      expect(yield* userExec.secrets.get("api-token")).toBe("org-value");
    }),
  );

  it.effect("write target lands in stack.write, not the innermost read scope", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");
      const store = new Map<string, string>();

      // writeIndex = 1 (org) while reading [user, org]. Mirrors the
      // "save for the whole team" toggle on the add-secret form.
      const exec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          writeIndex: 1,
          plugins: [sharedSecretsPlugin(store)()] as const,
        }),
      );

      const ref = yield* exec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-token"),
          name: "Shared",
          value: "v",
        }),
      );
      expect(ref.scopeId).toBe(org.id);
    }),
  );

  it.effect("rows outside the read chain are invisible", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");
      const other = makeTestScope("org-2", "Other Org");

      const schema = collectSchemas([sharedSecretsPlugin(new Map())()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const store = new Map<string, string>();
      const backing = { adapter, blobs };

      // A tenant in a completely different org writes a secret with the
      // same id — cross-tenant isolation must keep this invisible.
      const otherExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [other],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );
      yield* otherExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          name: "Other tenant",
          value: "other-value",
        }),
      );

      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );

      const list = yield* userExec.secrets.list();
      // The backing Map is shared so provider.list() still enumerates
      // `api-token`. The test asserts core-table isolation: no entry in
      // the list should be stamped with `other.id`. Provider-only
      // enumeration falls back to the write target, never surfaces
      // rows from non-chain scopes.
      const stampedWithOther = list.find((s) => s.scopeId === other.id);
      expect(stampedWithOther).toBeUndefined();
    }),
  );

  it.effect("list reports each row's actual scope_id (including org rows)", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");

      const schema = collectSchemas([sharedSecretsPlugin(new Map())()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const store = new Map<string, string>();
      const backing = { adapter, blobs };

      const orgExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );
      yield* orgExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-only"),
          name: "Shared",
          value: "s",
        }),
      );

      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );
      yield* userExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("user-only"),
          name: "User only",
          value: "u",
        }),
      );

      const list = yield* userExec.secrets.list();
      const byId = new Map(list.map((s) => [String(s.id), s]));

      expect(byId.get("shared-only")?.scopeId).toBe(org.id);
      expect(byId.get("user-only")?.scopeId).toBe(user.id);
    }),
  );

  it.effect("list shadows duplicates to the innermost row", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");

      const schema = collectSchemas([sharedSecretsPlugin(new Map())()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const store = new Map<string, string>();
      const backing = { adapter, blobs };

      const orgExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );
      yield* orgExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("dup"),
          name: "Org",
          value: "org",
        }),
      );

      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [sharedSecretsPlugin(store)()] as const,
          sharedBacking: backing,
        }),
      );
      yield* userExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("dup"),
          name: "User",
          value: "user",
        }),
      );

      const list = yield* userExec.secrets.list();
      const dups = list.filter((s) => s.id === "dup");
      expect(dups).toHaveLength(1);
      // Innermost (user) wins shadowing.
      expect(dups[0]!.scopeId).toBe(user.id);
      expect(dups[0]!.name).toBe("User");
    }),
  );

  it.effect("scopeStack is exposed on the executor", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");

      const exec = yield* createExecutor(
        makeLayeredTestConfig({ read: [user, org] }),
      );

      expect(exec.scopeStack).toBeInstanceOf(ScopeStack);
      expect(exec.scopeStack.read.map((s) => s.id)).toEqual([user.id, org.id]);
      expect(exec.scopeStack.write.id).toBe(user.id);
      // `executor.scope` is a shortcut for `scopeStack.write`.
      expect(exec.scope.id).toBe(user.id);
    }),
  );

  it.effect("single-scope config stays equivalent to a 1-element stack", () =>
    Effect.gen(function* () {
      const org = makeTestScope("org-1");
      const store = new Map<string, string>();

      const exec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [sharedSecretsPlugin(store)()] as const,
        }),
      );

      yield* exec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("t"),
          name: "T",
          value: "v",
        }),
      );
      expect(yield* exec.secrets.get("t")).toBe("v");
      expect(exec.scopeStack.read).toHaveLength(1);
    }),
  );
});

// ---------------------------------------------------------------------------
// Sources + tools shadowing. A plugin that registers a source with the
// same id at two scopes must surface the innermost row through
// sources.list / tools.list / tools.invoke / tools.schema.
// ---------------------------------------------------------------------------

const registrarPlugin = definePlugin(() => ({
  id: "reg" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    register: (opts: {
      readonly sourceId: string;
      readonly sourceName: string;
      readonly toolName: string;
      readonly toolDescription: string;
    }) =>
      ctx.core.sources.register({
        id: opts.sourceId,
        kind: "reg",
        name: opts.sourceName,
        canRemove: true,
        tools: [{ name: opts.toolName, description: opts.toolDescription }],
      }),
  }),
  invokeTool: ({ toolRow }) =>
    Effect.succeed({
      description: toolRow.description,
      name: toolRow.name,
    }),
}));

describe("layered scope: sources + tools shadowing", () => {
  it.effect("sources.list collapses duplicate ids to the innermost scope", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");
      const schema = collectSchemas([registrarPlugin()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const backing = { adapter, blobs };

      const orgExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [registrarPlugin()] as const,
          sharedBacking: backing,
        }),
      );
      yield* orgExec.reg.register({
        sourceId: "shared",
        sourceName: "Org default",
        toolName: "run",
        toolDescription: "org-run",
      });

      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [registrarPlugin()] as const,
          sharedBacking: backing,
        }),
      );
      yield* userExec.reg.register({
        sourceId: "shared",
        sourceName: "User override",
        toolName: "run",
        toolDescription: "user-run",
      });

      const sources = yield* userExec.sources.list();
      const shared = sources.filter((s) => s.id === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]!.name).toBe("User override");
    }),
  );

  it.effect("tools.list shadows collisions to the innermost row", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");
      const schema = collectSchemas([registrarPlugin()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const backing = { adapter, blobs };

      const orgExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [registrarPlugin()] as const,
          sharedBacking: backing,
        }),
      );
      yield* orgExec.reg.register({
        sourceId: "shared",
        sourceName: "Org",
        toolName: "run",
        toolDescription: "org-run",
      });

      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [registrarPlugin()] as const,
          sharedBacking: backing,
        }),
      );
      yield* userExec.reg.register({
        sourceId: "shared",
        sourceName: "User",
        toolName: "run",
        toolDescription: "user-run",
      });

      const tools = yield* userExec.tools.list();
      const matches = tools.filter((t) => t.id === "shared.run");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.description).toBe("user-run");
    }),
  );

  it.effect("tools.invoke dispatches to the innermost row's plugin state", () =>
    Effect.gen(function* () {
      const user = makeTestScope("user-A");
      const org = makeTestScope("org-1");
      const schema = collectSchemas([registrarPlugin()]);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const backing = { adapter, blobs };

      const orgExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [org],
          plugins: [registrarPlugin()] as const,
          sharedBacking: backing,
        }),
      );
      yield* orgExec.reg.register({
        sourceId: "shared",
        sourceName: "Org",
        toolName: "run",
        toolDescription: "org-run",
      });

      const userExec = yield* createExecutor(
        makeLayeredTestConfig({
          read: [user, org],
          plugins: [registrarPlugin()] as const,
          sharedBacking: backing,
        }),
      );
      yield* userExec.reg.register({
        sourceId: "shared",
        sourceName: "User",
        toolName: "run",
        toolDescription: "user-run",
      });

      // invokeTool receives the chosen row; confirm it's the user-scope
      // copy.
      const result = (yield* userExec.tools.invoke("shared.run", {})) as {
        description: string;
        name: string;
      };
      expect(result.description).toBe("user-run");
    }),
  );
});
