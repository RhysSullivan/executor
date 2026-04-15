import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor } from "./executor";
import {
  ElicitationResponse,
  FormElicitation,
} from "./elicitation";
import { definePlugin } from "./plugin";
import { SetSecretInput } from "./secrets";
import { makeTestConfig } from "./testing";
import type { SecretProvider } from "./secrets";
import { SecretId } from "./ids";

// ---------------------------------------------------------------------------
// Tiny test plugin — declares a static source with two control tools, a
// plugin schema for a per-row key/value table, and a dynamic invokeTool
// handler. Exercises everything createExecutor has to wire up.
// ---------------------------------------------------------------------------

interface TestStore {
  readonly writeThing: (id: string, value: string) => Effect.Effect<void, Error>;
  readonly readThing: (id: string) => Effect.Effect<string | null, Error>;
}

const testPlugin = definePlugin(() => ({
  id: "test" as const,
  schema: {
    test_thing: {
      modelName: "test_thing",
      fields: {
        id: { type: "string", required: true },
        value: { type: "string", required: true },
      },
    },
  },
  storage: ({ adapter }): TestStore => ({
    writeThing: (id, value) =>
      adapter
        .create({
          model: "test_thing",
          data: { id, value },
          forceAllowId: true,
        })
        .pipe(Effect.asVoid),
    readThing: (id) =>
      adapter
        .findOne<{ id: string; value: string }>({
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
            id: `test.${id}`,
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
      // toolRow.id = "test.<id>.<name>"
      const [, thingId, methodName] = toolRow.id.split(".");
      if (methodName === "read") {
        return yield* ctx.storage.readThing(thingId!);
      }
      if (methodName === "write") {
        const { value } = args as { value: string };
        yield* ctx.storage.writeThing(thingId!, value);
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
      expect(ids).toContain("test.thing1.read");
      expect(ids).toContain("test.thing1.write");
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

      const result = yield* executor.tools.invoke("test.thing1.read", {});
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
          "test.thing1.write",
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
        "test.thing1.write",
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

      const dynamic = sources.find((s) => s.id === "test.thing1");
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
