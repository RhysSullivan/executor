// ---------------------------------------------------------------------------
// Typed-error model — SDK-level behavioural tests.
//
// The happy-path tests in executor.test.ts don't exercise storage-failure
// propagation because the in-memory adapter never fails. These tests
// inject a deliberately failing adapter and verify the SDK surface:
//
//   1. `StorageError` from a backend surfaces *raw* in the typed error
//      channel — no telemetry, no InternalError translation. The HTTP
//      edge (`@executor/api` `withCapture`) is the one layer
//      that translates to the opaque InternalError; non-HTTP consumers
//      (CLI, Promise SDK, tests, plugins) can react to the raw tag.
//   2. `UniqueViolationError` also passes through raw — plugin code
//      can `Effect.catchTag` and translate to its own user-facing
//      typed error.
//   3. `createExecutor` has no ErrorCapture requirement at all — no
//      service lookup, no R channel leak.
//
// See `notes/error-handling.md` for the architectural overview and
// `@executor/api` `observability.test.ts` for the edge-translation
// tests.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  StorageError,
  UniqueViolationError,
  type DBAdapter,
  type DBTransactionAdapter,
  type StorageFailure,
} from "@executor/storage-core";
import { makeInMemoryBlobStore } from "./blob";
import { createExecutor } from "./executor";
import { ScopeId } from "./ids";
import { defineSchema, definePlugin } from "./plugin";
import { Scope } from "./scope";

// ---------------------------------------------------------------------------
// Test helpers — an adapter that deterministically fails every method
// with a chosen StorageFailure, and a scope fixture.
// ---------------------------------------------------------------------------

const makeFailingAdapter = (failure: StorageFailure): DBAdapter => {
  const fail = () =>
    Effect.fail(failure) as Effect.Effect<never, StorageFailure, never>;
  return {
    id: "failing",
    create: fail as DBAdapter["create"],
    createMany: fail as DBAdapter["createMany"],
    findOne: fail as DBAdapter["findOne"],
    findMany: fail as DBAdapter["findMany"],
    count: fail as DBAdapter["count"],
    update: fail as DBAdapter["update"],
    updateMany: fail as DBAdapter["updateMany"],
    delete: fail as DBAdapter["delete"],
    deleteMany: fail as DBAdapter["deleteMany"],
    transaction: ((callback: (trx: DBTransactionAdapter) => unknown) => {
      void callback;
      return Effect.fail(failure);
    }) as DBAdapter["transaction"],
  };
};

const testScope = new Scope({
  id: ScopeId.make("test-scope"),
  name: "test",
  createdAt: new Date(),
});

const baseConfig = (adapter: DBAdapter) => ({
  scopes: [testScope],
  adapter,
  blobs: makeInMemoryBlobStore(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("typed-error edge model — SDK", () => {
  it.effect("StorageError propagates raw through the executor surface", () =>
    Effect.gen(function* () {
      const failure = new StorageError({
        message: "backend lost its mind",
        cause: new Error("driver kaboom"),
      });
      const executor = yield* createExecutor(
        baseConfig(makeFailingAdapter(failure)),
      );

      const result = yield* executor.tools.list().pipe(Effect.flip);
      expect(result).toBeInstanceOf(StorageError);
      expect(result._tag).toBe("StorageError");
      // Original cause preserved end-to-end.
      const storageErr = result as StorageError;
      expect(storageErr.message).toBe("backend lost its mind");
      expect(storageErr.cause).toBeInstanceOf(Error);
      expect((storageErr.cause as Error).message).toBe("driver kaboom");
    }),
  );

  // ---------------------------------------------------------------------------
  // UniqueViolationError propagates unchanged — plugins can catchTag it.
  // Build a tiny plugin whose storage method calls adapter.create and
  // whose extension method exposes a method that catches
  // UniqueViolationError and resolves with a sentinel. If the catch
  // fires, UniqueViolationError reached the plugin code intact.
  // ---------------------------------------------------------------------------

  const uniqueSchema = defineSchema({
    thing: {
      fields: {
        id: { type: "string", required: true },
      },
    },
  });

  const uniqueTestPlugin = definePlugin(() => ({
    id: "uniq-test" as const,
    schema: uniqueSchema,
    storage: ({ adapter }) => ({
      tryCreate: (id: string) =>
        adapter
          .create({
            model: "thing",
            data: { id },
            forceAllowId: true,
          })
          .pipe(
            Effect.catchTag("UniqueViolationError", (err) =>
              Effect.succeed({
                caught: true as const,
                model: err.model ?? null,
              }),
            ),
            Effect.map((r) =>
              "caught" in r ? r : { caught: false as const, model: null },
            ),
          ),
    }),
    extension: (ctx) => ({
      create: (id: string) => ctx.storage.tryCreate(id),
    }),
  }));

  it.effect("UniqueViolationError propagates through plugin code (catchTag works)", () =>
    Effect.gen(function* () {
      const failure = new UniqueViolationError({ model: "thing" });
      const executor = yield* createExecutor({
        ...baseConfig(makeFailingAdapter(failure)),
        plugins: [uniqueTestPlugin()] as const,
      });

      const result = yield* executor["uniq-test"].create("abc");
      expect(result.caught).toBe(true);
      expect(result.model).toBe("thing");
    }),
  );

  it.effect("createExecutor has no ErrorCapture requirement (no R leak)", () =>
    Effect.gen(function* () {
      // No `.pipe(Effect.provide(...))` anywhere; just run. If the SDK
      // still required any observability service, this wouldn't
      // type-check (R would leak) nor run (would crash at construction).
      const executor = yield* createExecutor(
        baseConfig(
          makeFailingAdapter(
            new StorageError({ message: "doesn't matter", cause: undefined }),
          ),
        ),
      );
      // Sanity: the executor surface exists and methods are callable.
      expect(typeof executor.tools.list).toBe("function");
      expect(typeof executor.sources.list).toBe("function");
    }),
  );
});
