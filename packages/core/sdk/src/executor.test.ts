import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import { collectSchemas, createExecutor } from "./executor";
import {
  ElicitationResponse,
  FormElicitation,
  UrlElicitation,
} from "./elicitation";
import { defineSchema, definePlugin } from "./plugin";
import { SetSecretInput } from "./secrets";
import { makeTestConfig } from "./testing";
import type { SecretProvider } from "./secrets";
import { ScopeId, SecretId } from "./ids";
import { Scope } from "./scope";

// ---------------------------------------------------------------------------
// Tiny test plugin — declares a static source with two control tools, a
// plugin schema for a per-row key/value table, and a dynamic invokeTool
// handler. Exercises everything createExecutor has to wire up.
// ---------------------------------------------------------------------------

// Plugin-declared schema. `defineSchema` preserves literal types via
// `const` inference — no `as const satisfies DBSchema` ceremony.
const testSchema = defineSchema({
  test_thing: {
    fields: {
      id: { type: "string", required: true },
      value: { type: "string", required: true },
    },
  },
});

const testPlugin = definePlugin(() => ({
  id: "test" as const,
  schema: testSchema,

  // `adapter` is typed against testSchema automatically — no imports of
  // DBAdapter, no typedAdapter wrapping. `model: "test_thing"` is
  // narrowed to the schema's model names, and row data shape comes
  // from the schema's field definitions.
  storage: ({ adapter }) => ({
    writeThing: (id: string, value: string) =>
      adapter
        .create({
          model: "test_thing",
          data: { id, value },
          forceAllowId: true,
        })
        .pipe(Effect.asVoid),
    readThing: (id: string) =>
      adapter
        .findOne({
          model: "test_thing",
          where: [{ field: "id", value: id }],
        })
        .pipe(Effect.map((row) => row?.value ?? null)),
  }),
  extension: (ctx) => ({
    echo: (text: string) => Effect.succeed(`echo:${text}`),

    addThing: (id: string, value: string) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.writeThing(id, value);
          yield* ctx.core.sources.register({
            id,
            kind: "test",
            name: id,
            canRemove: true,
            tools: [
              { name: "read", description: "read the thing" },
              { name: "write", description: "overwrite the thing" },
            ],
          });
        }),
      ),
  }),
  staticSources: (self) => [
    {
      id: "test.control",
      kind: "control",
      name: "Test Control",
      tools: [
        {
          name: "echo",
          description: "static echo tool",
          handler: ({ args }) => self.echo((args as { text: string }).text),
        },
      ],
    },
  ],
  invokeTool: ({ ctx, toolRow, args }) =>
    Effect.gen(function* () {
      // toolRow.source_id = the thing id (we registered the source with
      // that id). toolRow.name = "read" | "write". No string splitting.
      const thingId = toolRow.source_id;
      if (toolRow.name === "read") {
        return yield* ctx.storage.readThing(thingId);
      }
      if (toolRow.name === "write") {
        const { value } = args as { value: string };
        yield* ctx.storage.writeThing(thingId, value);
        return { ok: true };
      }
      return yield* Effect.fail(new Error(`unknown tool ${toolRow.id}`));
    }),

  // Derived annotations: `write` gates on approval, `read` doesn't.
  // Purely computed from the tool's name — no data persisted on the row.
  resolveAnnotations: ({ toolRows }) =>
    Effect.sync(() => {
      const out: Record<string, { requiresApproval: boolean; approvalDescription?: string }> = {};
      for (const row of toolRows) {
        if (row.name === "write") {
          out[row.id] = {
            requiresApproval: true,
            approvalDescription: `Overwrite ${row.source_id}`,
          };
        } else {
          out[row.id] = { requiresApproval: false };
        }
      }
      return out;
    }),
}));

// ---------------------------------------------------------------------------
// Test plugin that contributes an in-memory writable secret provider so
// the secrets surface has something to talk to.
// ---------------------------------------------------------------------------

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id) => Effect.sync(() => store.get(id) ?? null),
    set: (id, value) =>
      Effect.sync(() => {
        store.set(id, value);
      }),
    delete: (id) => Effect.sync(() => store.delete(id)),
    list: () =>
      Effect.sync(() => Array.from(store.keys()).map((id) => ({ id, name: id }))),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExecutor", () => {
  it.effect("invokes a static tool via the in-memory pool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      const result = yield* executor.tools.invoke("test.control.echo", {
        text: "hi",
      });
      expect(result).toBe("echo:hi");
    }),
  );

  it.effect("lists static tools alongside dynamic ones", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      yield* executor.test.addThing("thing1", "hello");

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("test.control.echo");
      expect(ids).toContain("thing1.read");
      expect(ids).toContain("thing1.write");
    }),
  );

  it.effect("filters tools by query", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      yield* executor.test.addThing("thing1", "hello");

      const tools = yield* executor.tools.list({ query: "echo" });
      expect(tools.map((t) => t.id)).toEqual(["test.control.echo"]);
    }),
  );

  it.effect("invokes a dynamic tool through plugin.invokeTool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      yield* executor.test.addThing("thing1", "hello");

      const result = yield* executor.tools.invoke("thing1.read", {});
      expect(result).toBe("hello");
    }),
  );

  it.effect("enforces tool annotations before invoking", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      yield* executor.test.addThing("thing1", "hello");

      // requiresApproval: true → declined → ElicitationDeclinedError
      const declined = yield* executor.tools
        .invoke(
          "thing1.write",
          { value: "updated" },
          {
            onElicitation: () =>
              Effect.succeed(new ElicitationResponse({ action: "decline" })),
          },
        )
        .pipe(Effect.flip);
      expect((declined as { _tag: string })._tag).toBe(
        "ElicitationDeclinedError",
      );

      // auto-accept → succeeds
      const accepted = yield* executor.tools.invoke(
        "thing1.write",
        { value: "updated" },
        { onElicitation: "accept-all" },
      );
      expect(accepted).toEqual({ ok: true });
    }),
  );

  it.effect("sources.list unions static runtime sources and dynamic ones", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      yield* executor.test.addThing("thing1", "hello");

      const sources = yield* executor.sources.list();
      const control = sources.find((s) => s.id === "test.control");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
      expect(control!.canRemove).toBe(false);

      const dynamic = sources.find((s) => s.id === "thing1");
      expect(dynamic).toBeDefined();
      expect(dynamic!.runtime).toBe(false);
      expect(dynamic!.canRemove).toBe(true);
    }),
  );

  it.effect("rejects remove of a static source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      const err = yield* executor.sources
        .remove("test.control")
        .pipe(Effect.flip);
      expect((err as { _tag: string })._tag).toBe(
        "SourceRemovalNotAllowedError",
      );
    }),
  );

  it.effect("handles deeply-namespaced tool names (dots in name)", () =>
    Effect.gen(function* () {
      const namespacedPlugin = definePlugin(() => ({
        id: "nested" as const,
        storage: () => ({}),
        extension: (ctx) => ({
          register: () =>
            ctx.core.sources.register({
              id: "cloudflare",
              kind: "nested",
              name: "cloudflare",
              canRemove: true,
              tools: [
                { name: "dns.records.create", description: "create DNS record" },
                { name: "dns.records.list", description: "list DNS records" },
                { name: "zones.listZones", description: "list zones" },
              ],
            }),
        }),
        invokeTool: ({ toolRow }) =>
          // Real plugin would look up by toolRow.id against its own
          // enrichment table. Here we just echo the structured fields
          // so the test can assert they came through intact.
          Effect.succeed({
            id: toolRow.id,
            sourceId: toolRow.source_id,
            name: toolRow.name,
          }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [namespacedPlugin()] as const }),
      );
      yield* executor.nested.register();

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id).sort();
      expect(ids).toContain("cloudflare.dns.records.create");
      expect(ids).toContain("cloudflare.dns.records.list");
      expect(ids).toContain("cloudflare.zones.listZones");

      // Invoke by the exact id — dots are just characters, never parsed.
      const result = (yield* executor.tools.invoke(
        "cloudflare.dns.records.create",
        {},
      )) as { id: string; sourceId: string; name: string };

      // Structured fields round-trip cleanly: source_id and name are
      // the exact strings the plugin registered.
      expect(result.id).toBe("cloudflare.dns.records.create");
      expect(result.sourceId).toBe("cloudflare");
      expect(result.name).toBe("dns.records.create");
    }),
  );

  it.effect("rejects dynamic registration that collides with a static id", () =>
    Effect.gen(function* () {
      const collidingPlugin = definePlugin(() => ({
        id: "collide" as const,
        storage: () => ({}),
        extension: (ctx) => ({
          tryRegister: () =>
            ctx.core.sources.register({
              id: "test.control", // collides with testPlugin's static source
              kind: "x",
              name: "x",
              tools: [],
            }),
        }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [testPlugin(), collidingPlugin()] as const,
        }),
      );

      const err = yield* executor.collide.tryRegister().pipe(Effect.flip);
      expect(err.message).toContain("collides with a static source");
    }),
  );

  it.effect("ctx.transaction commits all nested writes on success", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [testPlugin()] as const }),
      );
      // addThing wraps storage + sources.register in ctx.transaction.
      yield* executor.test.addThing("thing1", "hello");

      const sources = yield* executor.sources.list();
      expect(sources.find((s) => s.id === "thing1")).toBeDefined();

      const tools = (yield* executor.tools.list()).map((t) => t.id);
      expect(tools).toContain("thing1.read");
      expect(tools).toContain("thing1.write");

      // plugin storage row committed too
      expect(yield* executor.tools.invoke("thing1.read", {})).toBe("hello");
    }),
  );

  it.effect("ctx.transaction rolls back all nested writes on failure", () =>
    Effect.gen(function* () {
      // Plugin that does: storage write -> core.sources.register -> fail.
      // Every write must roll back.
      const rollbackPlugin = definePlugin(() => ({
        id: "rollback" as const,
        schema: testSchema,
        storage: ({ adapter }) => ({
          writeThing: (id: string, value: string) =>
            adapter
              .create({
                model: "test_thing",
                data: { id, value },
                forceAllowId: true,
              })
              .pipe(Effect.asVoid),
          countThings: () => adapter.count({ model: "test_thing" }),
        }),
        extension: (ctx) => ({
          doFailingTx: () =>
            ctx.transaction(
              Effect.gen(function* () {
                yield* ctx.storage.writeThing("x1", "v1");
                yield* ctx.core.sources.register({
                  id: "rb-source",
                  kind: "rb",
                  name: "rb",
                  canRemove: true,
                  tools: [{ name: "t", description: "t" }],
                });
                return yield* Effect.fail(new Error("boom"));
              }),
            ),
          countThings: () => ctx.storage.countThings(),
        }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [rollbackPlugin()] as const }),
      );

      const result = yield* executor.rollback
        .doFailingTx()
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");

      // Plugin storage row must not persist.
      expect(yield* executor.rollback.countThings()).toBe(0);
      // Core source registration must not persist.
      const sources = yield* executor.sources.list();
      expect(sources.find((s) => s.id === "rb-source")).toBeUndefined();
      const tools = (yield* executor.tools.list()).map((t) => t.id);
      expect(tools).not.toContain("rb-source.t");
    }),
  );

  it.effect("secrets.set writes to provider and metadata row", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          name: "API Token",
          value: "sk-abc",
        }),
      );

      const value = yield* executor.secrets.get("api-token");
      expect(value).toBe("sk-abc");

      const list = yield* executor.secrets.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe("API Token");
      expect(list[0]!.provider).toBe("memory");
    }),
  );

  it.effect("invoke fails with ToolNotFoundError for unknown tool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig());
      const err = yield* executor.tools
        .invoke("does.not.exist", {})
        .pipe(Effect.flip);
      expect((err as { _tag: string })._tag).toBe("ToolNotFoundError");
    }),
  );

  it.effect("tools.schema renders TypeScript previews for static tools", () =>
    Effect.gen(function* () {
      const previewPlugin = definePlugin(() => ({
        id: "preview" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "preview.ctl",
            kind: "control",
            name: "Preview Ctl",
            tools: [
              {
                name: "createContact",
                description: "create",
                inputSchema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    age: { type: "number" },
                  },
                  required: ["name", "age"],
                  additionalProperties: false,
                },
                outputSchema: { type: "string" },
                handler: ({ args }) => Effect.succeed(args),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [previewPlugin()] as const }),
      );

      const schema = yield* executor.tools.schema("preview.ctl.createContact");
      expect(schema).not.toBeNull();
      expect(schema!.inputTypeScript).toBe("{ name: string; age: number }");
      expect(schema!.outputTypeScript).toBe("string");
    }),
  );

  it.effect("close calls each plugin's close hook", () =>
    Effect.gen(function* () {
      let closed = 0;
      const closeable = definePlugin(() => ({
        id: "closeable" as const,
        storage: () => ({}),
        close: () => Effect.sync(() => void closed++),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [closeable()] as const }),
      );

      yield* executor.close();
      expect(closed).toBe(1);
    }),
  );

  it.effect("static tool can suspend mid-invocation with FormElicitation", () =>
    Effect.gen(function* () {
      const loginPlugin = definePlugin(() => ({
        id: "login" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "login.ctl",
            kind: "control",
            name: "Login",
            tools: [
              {
                name: "signIn",
                description: "sign in",
                handler: ({ elicit }) =>
                  Effect.gen(function* () {
                    const response = yield* elicit(
                      new FormElicitation({
                        message: "Enter credentials",
                        requestedSchema: {
                          type: "object",
                          properties: {
                            username: { type: "string" },
                            password: { type: "string" },
                          },
                        },
                      }),
                    );
                    return {
                      user: response.content?.username,
                      status: "logged_in",
                    };
                  }),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [loginPlugin()] as const }),
      );

      const result = yield* executor.tools.invoke(
        "login.ctl.signIn",
        {},
        {
          onElicitation: (ctx) => {
            expect(ctx.request._tag).toBe("FormElicitation");
            return Effect.succeed(
              new ElicitationResponse({
                action: "accept",
                content: { username: "alice", password: "s3cret" },
              }),
            );
          },
        },
      );

      expect(result).toEqual({ user: "alice", status: "logged_in" });
    }),
  );

  it.effect("static tool can request URL visit via UrlElicitation", () =>
    Effect.gen(function* () {
      const oauthPlugin = definePlugin(() => ({
        id: "oauth" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "oauth.ctl",
            kind: "control",
            name: "OAuth",
            tools: [
              {
                name: "connect",
                description: "oauth connect",
                handler: ({ elicit }) =>
                  Effect.gen(function* () {
                    const response = yield* elicit(
                      new UrlElicitation({
                        message: "Authorize the app",
                        url: "https://oauth.example.com/authorize?state=abc",
                        elicitationId: "oauth-abc",
                      }),
                    );
                    return {
                      connected: true,
                      code: response.content?.code,
                    };
                  }),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [oauthPlugin()] as const }),
      );

      const result = yield* executor.tools.invoke(
        "oauth.ctl.connect",
        {},
        {
          onElicitation: (ctx) => {
            expect(ctx.request._tag).toBe("UrlElicitation");
            return Effect.succeed(
              new ElicitationResponse({
                action: "accept",
                content: { code: "auth-code-123" },
              }),
            );
          },
        },
      );

      expect(result).toEqual({ connected: true, code: "auth-code-123" });
    }),
  );

  // NOTE: behavior change vs. main — the SDK used to auto-decline when no
  // onElicitation handler was provided (yielding ElicitationDeclinedError).
  // The new resolver falls back to acceptAllHandler instead. Test locks in
  // the current behavior; flip the assertion if the default is reverted.
  it.effect("invoke auto-accepts elicitation when no handler is provided", () =>
    Effect.gen(function* () {
      const elicitOnly = definePlugin(() => ({
        id: "elicitOnly" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "elicit.ctl",
            kind: "control",
            name: "Elicit Ctl",
            tools: [
              {
                name: "ask",
                description: "ask the user",
                handler: ({ elicit }) =>
                  Effect.gen(function* () {
                    const response = yield* elicit(
                      new FormElicitation({
                        message: "Anything?",
                        requestedSchema: {},
                      }),
                    );
                    return response.action;
                  }),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [elicitOnly()] as const }),
      );

      const action = yield* executor.tools.invoke("elicit.ctl.ask", {});
      expect(action).toBe("accept");
    }),
  );

  it.effect("plugin reads and writes secrets via ctx.secrets", () =>
    Effect.gen(function* () {
      const rotatePlugin = definePlugin(() => ({
        id: "rotate" as const,
        storage: () => ({}),
        extension: (ctx) => ({
          rotate: (id: string, newValue: string) =>
            Effect.gen(function* () {
              const old = yield* ctx.secrets.get(id);
              if (old !== null) {
                yield* ctx.secrets.remove(id);
              }
              yield* ctx.secrets.set(
                new SetSecretInput({
                  id: SecretId.make(id),
                  name: id,
                  value: newValue,
                }),
              );
              return { oldValue: old, newValue };
            }),
        }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), rotatePlugin()] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("DB_PASSWORD"),
          name: "DB_PASSWORD",
          value: "hunter2",
        }),
      );

      const result = yield* executor.rotate.rotate(
        "DB_PASSWORD",
        "correct-horse-battery-staple",
      );
      expect(result).toEqual({
        oldValue: "hunter2",
        newValue: "correct-horse-battery-staple",
      });

      const after = yield* executor.secrets.get("DB_PASSWORD");
      expect(after).toBe("correct-horse-battery-staple");
    }),
  );
});

// ---------------------------------------------------------------------------
// Tenant isolation — two executors with different scopes sharing the same
// adapter / blob store. Every SDK surface that reads rows must filter by
// the calling scope; the adapter has no scope concept, so the guarantee
// has to live in the executor / core-table layer. These tests pin the
// invariant at the cheapest possible level (in-memory adapter).
// ---------------------------------------------------------------------------

// Per-executor memory provider — mirrors production where each org's
// `workos-vault` plugin instance has its own client scoped to that org.
// A module-level shared provider would leak across scopes on its own,
// independent of the core.secret routing table isolation we're testing.
const makeScopedMemoryProvider = (): SecretProvider => {
  const store = new Map<string, string>();
  return {
    key: "scoped-memory",
    writable: true,
    get: (id) => Effect.sync(() => store.get(id) ?? null),
    set: (id, value) =>
      Effect.sync(() => {
        store.set(id, value);
      }),
    delete: (id) => Effect.sync(() => store.delete(id)),
    list: () =>
      Effect.sync(() => Array.from(store.keys()).map((id) => ({ id, name: id }))),
  };
};

const tenantPlugin = definePlugin(() => ({
  id: "tenant" as const,
  storage: () => ({}),
  secretProviders: () => [makeScopedMemoryProvider()],
  staticSources: () => [
    {
      id: "tenant.ctl",
      kind: "control" as const,
      name: "Tenant Ctl",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: { type: "object", additionalProperties: false },
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
  extension: (ctx) => ({
    addSource: (id: string) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.sources.register({
            id,
            kind: "tenant",
            name: id,
            canRemove: true,
            tools: [{ name: "t", description: "t" }],
          });
        }),
      ),
  }),
}));

const makeSharedTenantExecutors = () =>
  Effect.gen(function* () {
    const plugins = [tenantPlugin()] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const makeOne = (id: string) =>
      createExecutor({
        scope: new Scope({
          id: ScopeId.make(id),
          name: id,
          createdAt: new Date(),
        }),
        adapter,
        blobs,
        plugins,
      });

    const execA = yield* makeOne("scope-a");
    const execB = yield* makeOne("scope-b");
    return { execA, execB };
  });

describe("tenant isolation (SDK)", () => {
  it.effect("sources.list does not leak across scopes", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.tenant.addSource("a-source");

      const bSources = yield* execB.sources.list();
      expect(bSources.map((s) => s.id)).not.toContain("a-source");
    }),
  );

  it.effect("tools.list does not leak across scopes", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.tenant.addSource("a-source");

      const bTools = yield* execB.tools.list();
      expect(bTools.map((t) => t.sourceId)).not.toContain("a-source");
    }),
  );

  it.effect("secrets.list does not leak across scopes", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-id"),
          name: "A only",
          value: "a-value",
        }),
      );

      const bSecrets = yield* execB.secrets.list();
      expect(bSecrets.map((s) => s.id)).not.toContain("shared-id");
    }),
  );

  it.effect("secrets.status for another scope's id returns missing", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-id"),
          name: "A only",
          value: "a-value",
        }),
      );

      const status = yield* execB.secrets.status("shared-id");
      expect(status).toBe("missing");
    }),
  );

  it.effect("secrets.get cannot read another scope's value", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-id"),
          name: "A only",
          value: "a-value",
        }),
      );

      const value = yield* execB.secrets.get("shared-id");
      expect(value).toBeNull();
    }),
  );
});
