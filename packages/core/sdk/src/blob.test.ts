import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { StorageError } from "@executor/storage-core";

import { makeInMemoryBlobStore, pluginBlobStore } from "./blob";

describe("pluginBlobStore", () => {
  it.effect("get returns innermost scope's value when both scopes have one", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("inner/my-plugin", "k", "inner-value");
      yield* store.put("outer/my-plugin", "k", "outer-value");

      const plugin = pluginBlobStore(store, ["inner", "outer"], "my-plugin");
      const value = yield* plugin.get("k");
      expect(value).toBe("inner-value");
    }),
  );

  it.effect("get falls through to outer scope when inner is empty", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("outer/my-plugin", "k", "outer-value");

      const plugin = pluginBlobStore(store, ["inner", "outer"], "my-plugin");
      const value = yield* plugin.get("k");
      expect(value).toBe("outer-value");
    }),
  );

  it.effect("get returns null when no scope has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, ["inner", "outer"], "my-plugin");
      const value = yield* plugin.get("k");
      expect(value).toBeNull();
    }),
  );

  it.effect("has returns true when any scope has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("outer/my-plugin", "k", "v");

      const plugin = pluginBlobStore(store, ["inner", "outer"], "my-plugin");
      const found = yield* plugin.has("k");
      expect(found).toBe(true);
    }),
  );

  it.effect("has returns false when no scope has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, ["inner", "outer"], "my-plugin");
      const found = yield* plugin.has("k");
      expect(found).toBe(false);
    }),
  );

  it.effect("namespaces are keyed by scope/pluginId — different plugins don't collide", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("inner/plugin-a", "k", "a-value");
      yield* store.put("inner/plugin-b", "k", "b-value");

      const pluginA = pluginBlobStore(store, ["inner"], "plugin-a");
      const pluginB = pluginBlobStore(store, ["inner"], "plugin-b");
      expect(yield* pluginA.get("k")).toBe("a-value");
      expect(yield* pluginB.get("k")).toBe("b-value");
    }),
  );

  it.effect("put rejects scope outside the stack", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, ["inner", "outer"], "my-plugin");
      const result = yield* Effect.exit(
        plugin.put("k", "v", { scope: "not-in-stack" }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const err = result.cause._tag === "Fail" ? result.cause.error : null;
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).message).toContain("not in the");
      }
      // Write must not have reached the store.
      expect(yield* store.get("not-in-stack/my-plugin", "k")).toBeNull();
    }),
  );

  it.effect("delete rejects scope outside the stack", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, ["inner"], "my-plugin");
      const result = yield* Effect.exit(
        plugin.delete("k", { scope: "not-in-stack" }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});

describe("BlobStore.getMany", () => {
  it.effect("returns hits keyed by namespace", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("ns-a", "k", "a");
      yield* store.put("ns-c", "k", "c");

      const hits = yield* store.getMany(["ns-a", "ns-b", "ns-c"], "k");
      expect(hits.size).toBe(2);
      expect(hits.get("ns-a")).toBe("a");
      expect(hits.get("ns-b")).toBeUndefined();
      expect(hits.get("ns-c")).toBe("c");
    }),
  );

  it.effect("empty namespaces returns empty map", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const hits = yield* store.getMany([], "k");
      expect(hits.size).toBe(0);
    }),
  );
});
