import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, type Executor } from "./executor";
import { Tenant } from "./ids";

const MEMORY_CACHE_CAPACITY = 2_048;
const MEMORY_CACHE_TTL_MS = 10 * 60 * 1000;

const makeExecutor = Effect.acquireRelease(
  createExecutor({
    tenant: Tenant.make("test-tenant"),
    onElicitation: "accept-all",
  }),
  (executor) => executor.close().pipe(Effect.ignore),
);

const withFakeNow = <A, E, R>(
  initialNow: number,
  run: (clock: { readonly advance: (ms: number) => void }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const originalNow = Date.now;
      let now = initialNow;
      Date.now = () => now;
      return {
        advance: (ms: number) => {
          now += ms;
        },
        restore: () => {
          Date.now = originalNow;
        },
      };
    }),
    (clock) => run({ advance: clock.advance }),
    (clock) => Effect.sync(clock.restore),
  );

describe("executor cache", () => {
  it.effect("uses an in-memory fallback when no cache is configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makeExecutor;

        yield* executor.cache.set("a", "value");
        expect(yield* executor.cache.get("a")).toBe("value");

        yield* executor.cache.remove("a");
        expect(yield* executor.cache.get("a")).toBeUndefined();
      }),
    ),
  );

  it.effect("expires fallback entries by TTL on get and size", () =>
    withFakeNow(1_000, ({ advance }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* makeExecutor;

          yield* executor.cache.set("a", "value");
          expect(yield* executor.cache.size).toBe(1);

          advance(MEMORY_CACHE_TTL_MS);

          expect(yield* executor.cache.get("a")).toBeUndefined();
          expect(yield* executor.cache.size).toBe(0);
        }),
      ),
    ),
  );

  it.effect("refreshes fallback LRU position when an existing key is written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor: Executor = yield* makeExecutor;

        yield* executor.cache.set("a", "old");
        for (let index = 0; index < MEMORY_CACHE_CAPACITY - 1; index += 1) {
          yield* executor.cache.set(`key-${index}`, String(index));
        }

        yield* executor.cache.set("a", "new");
        yield* executor.cache.set("overflow", "value");

        expect(yield* executor.cache.get("a")).toBe("new");
        expect(yield* executor.cache.get("key-0")).toBeUndefined();
        expect(yield* executor.cache.get("key-1")).toBe("1");
      }),
    ),
  );
});
