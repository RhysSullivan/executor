import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId } from "../ids";
import type { PluginKvStore } from "../stores/plugin-kv-store";

export interface PluginKvStoreContractConfig {
  readonly makeStore: () => Effect.Effect<{
    readonly store: PluginKvStore;
    readonly teardown: Effect.Effect<void>;
  }>;
}

export const createPluginKvStoreContract = (
  name: string,
  config: PluginKvStoreContractConfig,
): void => {
  describe(`${name} PluginKvStore contract`, () => {
    it.effect("upsert then get returns the value", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(ScopeId.make("s1"), "ns", [{ key: "k1", value: "v1" }]);
          const val = yield* store.get(ScopeId.make("s1"), "ns", "k1");
          expect(val).toBe("v1");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("list returns all entries for namespace", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(ScopeId.make("s1"), "ns", [
            { key: "a", value: "1" },
            { key: "b", value: "2" },
          ]);
          const entries = yield* store.list(ScopeId.make("s1"), "ns");
          expect(entries.length).toBe(2);
          const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
          expect(sorted[0]?.key).toBe("a");
          expect(sorted[1]?.key).toBe("b");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("different namespaces isolated", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(ScopeId.make("s1"), "ns-a", [{ key: "k", value: "from-a" }]);
          yield* store.upsert(ScopeId.make("s1"), "ns-b", [{ key: "k", value: "from-b" }]);
          const valA = yield* store.get(ScopeId.make("s1"), "ns-a", "k");
          const valB = yield* store.get(ScopeId.make("s1"), "ns-b", "k");
          expect(valA).toBe("from-a");
          expect(valB).toBe("from-b");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("different scopes isolated", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(ScopeId.make("scope-a"), "ns", [{ key: "k", value: "scope-a-val" }]);
          yield* store.upsert(ScopeId.make("scope-b"), "ns", [{ key: "k", value: "scope-b-val" }]);
          const valA = yield* store.get(ScopeId.make("scope-a"), "ns", "k");
          const valB = yield* store.get(ScopeId.make("scope-b"), "ns", "k");
          expect(valA).toBe("scope-a-val");
          expect(valB).toBe("scope-b-val");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("deleteKeys removes only specified, returns count", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(ScopeId.make("s1"), "ns", [
            { key: "x", value: "1" },
            { key: "y", value: "2" },
            { key: "z", value: "3" },
          ]);
          const count = yield* store.deleteKeys(ScopeId.make("s1"), "ns", ["x", "z"]);
          expect(count).toBe(2);
          const remaining = yield* store.list(ScopeId.make("s1"), "ns");
          expect(remaining.length).toBe(1);
          expect(remaining[0]?.key).toBe("y");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("deleteAll removes everything in namespace, returns count", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(ScopeId.make("s1"), "ns", [
            { key: "a", value: "1" },
            { key: "b", value: "2" },
          ]);
          const count = yield* store.deleteAll(ScopeId.make("s1"), "ns");
          expect(count).toBe(2);
          const remaining = yield* store.list(ScopeId.make("s1"), "ns");
          expect(remaining.length).toBe(0);
        } finally {
          yield* teardown;
        }
      }),
    );
  });
};
