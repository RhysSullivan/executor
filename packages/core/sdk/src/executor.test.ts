import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor } from "./executor";
import {
  ElicitationResponse,
  FormElicitation,
} from "./elicitation";
import { defineSchema, definePlugin } from "./plugin";
import { SetSecretInput } from "./secrets";
import { makeTestConfig } from "./testing";
import type { SecretProvider } from "./secrets";
import { SecretId } from "./ids";

// ---------------------------------------------------------------------------
// Tiny test plugin — declares a static source with two control tools, a
// plugin schema for a per-row key/value table, and a dynamic invokeTool
// handler. Exercises everything createExecutor has to wire up.
// ---------------------------------------------------------------------------

// Plugin-declared schema. `defineSchema` preserves literal types via
// `const` inference — no `as const satisfies DBSchema` ceremony.
const testSchema = defineSchema({
  test_thing: {
    modelName: "test_thing",
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
});
