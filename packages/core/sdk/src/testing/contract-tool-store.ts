import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ToolId, ScopeId } from "../ids";
import { ToolRegistration } from "../tools";
import type { ToolStore } from "../stores/tool-store";

export interface ToolStoreContractConfig {
  readonly makeStore: () => Effect.Effect<{
    readonly store: ToolStore;
    readonly teardown: Effect.Effect<void>;
  }>;
}

const makeTool = (id: string, overrides?: Partial<ToolRegistration>) =>
  new ToolRegistration({
    id: ToolId.make(id),
    pluginKey: "test-plugin",
    sourceId: "src-1",
    name: `tool-${id}`,
    description: `Description for ${id}`,
    mayElicit: false,
    ...overrides,
  });

export const createToolStoreContract = (
  name: string,
  config: ToolStoreContractConfig,
): void => {
  describe(`${name} ToolStore contract`, () => {
    it.effect("upsert then findById returns the tool", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          const tool = makeTool("a");
          yield* store.upsert([tool], ScopeId.make("s1"));
          const found = yield* store.findById(ToolId.make("a"), ScopeId.make("s1"));
          expect(found?.name).toBe("tool-a");
          expect(found?.pluginKey).toBe("test-plugin");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("upsert replaces existing tool in place", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert([makeTool("b")], ScopeId.make("s1"));
          yield* store.upsert(
            [makeTool("b", { name: "tool-b-updated" })],
            ScopeId.make("s1"),
          );
          const found = yield* store.findById(ToolId.make("b"), ScopeId.make("s1"));
          expect(found?.name).toBe("tool-b-updated");
          const all = yield* store.findByScope(ScopeId.make("s1"));
          expect(all.length).toBe(1);
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("findByScope returns only tools in that scope", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert([makeTool("c1"), makeTool("c2")], ScopeId.make("scope-a"));
          yield* store.upsert([makeTool("c3")], ScopeId.make("scope-b"));
          const tools = yield* store.findByScope(ScopeId.make("scope-a"));
          expect(tools.length).toBe(2);
          const ids = tools.map((t) => t.id as string).sort();
          expect(ids).toEqual(["c1", "c2"]);
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("findByScope in a different scope returns empty", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert([makeTool("d1")], ScopeId.make("scope-a"));
          const tools = yield* store.findByScope(ScopeId.make("scope-x"));
          expect(tools.length).toBe(0);
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("deleteByIds removes only the specified tools", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(
            [makeTool("e1"), makeTool("e2"), makeTool("e3")],
            ScopeId.make("s1"),
          );
          yield* store.deleteByIds([ToolId.make("e1"), ToolId.make("e3")], ScopeId.make("s1"));
          const remaining = yield* store.findByScope(ScopeId.make("s1"));
          expect(remaining.length).toBe(1);
          expect(remaining[0]?.id as string).toBe("e2");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("deleteBySource removes all tools of that source", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(
            [
              makeTool("f1", { sourceId: "src-alpha" }),
              makeTool("f2", { sourceId: "src-alpha" }),
              makeTool("f3", { sourceId: "src-beta" }),
            ],
            ScopeId.make("s1"),
          );
          yield* store.deleteBySource("src-alpha", ScopeId.make("s1"));
          const remaining = yield* store.findByScope(ScopeId.make("s1"));
          expect(remaining.length).toBe(1);
          expect(remaining[0]?.sourceId).toBe("src-beta");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("upsertDefinitions and findDefinitions round-trip", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          const defs = { MyType: { type: "string" }, OtherType: { type: "number" } };
          yield* store.upsertDefinitions(defs, ScopeId.make("s1"));
          const result = yield* store.findDefinitions(ScopeId.make("s1"));
          expect(result["MyType"]).toEqual({ type: "string" });
          expect(result["OtherType"]).toEqual({ type: "number" });
        } finally {
          yield* teardown;
        }
      }),
    );
  });
};
