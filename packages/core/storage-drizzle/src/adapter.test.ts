// ---------------------------------------------------------------------------
// Transient retry — protects against Hyperdrive handing us a stale pooled
// connection that drops mid-query. We retry StorageErrors whose message
// contains known transient markers; everything else fails fast.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schedule } from "effect";
import { StorageError, UniqueViolationError } from "@executor/storage-core";

import { isTransientStorageError } from "./adapter";

const transientMsg =
  "[storage-drizzle] findOne select failed: Network connection lost.";

describe("isTransientStorageError", () => {
  it.for([
    "[storage-drizzle] findOne select failed: Network connection lost.",
    "[storage-drizzle] findMany select failed: write CONNECTION_CLOSED e3b8b6d4dd90718f2a253e4d77d5ff00.hyperdrive.local:5432",
    "[storage-drizzle] insert returning failed: ECONNRESET",
    "[storage-drizzle] findMany select failed: Connection terminated unexpectedly",
  ])("returns true for %s", (message) => {
    expect(
      isTransientStorageError(new StorageError({ message, cause: null })),
    ).toBe(true);
  });

  it("returns false for unique violation", () => {
    expect(isTransientStorageError(new UniqueViolationError({}))).toBe(false);
  });

  it("returns false for unrelated storage errors", () => {
    expect(
      isTransientStorageError(
        new StorageError({ message: "syntax error at or near", cause: null }),
      ),
    ).toBe(false);
  });
});

// Mirrors the runPromise retry policy so we catch drift if it changes.
const retryPolicy = {
  while: isTransientStorageError,
  times: 2,
  schedule: Schedule.exponential("1 millis"),
} as const;

describe("transient retry policy", () => {
  it.live("retries transient failures and eventually succeeds", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* Effect.suspend(() => {
        calls++;
        if (calls < 3) {
          return Effect.fail(
            new StorageError({ message: transientMsg, cause: null }),
          );
        }
        return Effect.succeed("ok");
      }).pipe(Effect.retry(retryPolicy));

      expect(result).toBe("ok");
      expect(calls).toBe(3);
    }),
  );

  it.live("gives up after exhausting retries", () =>
    Effect.gen(function* () {
      let calls = 0;
      const exit = yield* Effect.exit(
        Effect.suspend(() => {
          calls++;
          return Effect.fail(
            new StorageError({ message: transientMsg, cause: null }),
          );
        }).pipe(Effect.retry(retryPolicy)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toBe(3); // 1 initial + 2 retries
    }),
  );

  it.live("does not retry unique violations", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.exit(
        Effect.suspend(() => {
          calls++;
          return Effect.fail(new UniqueViolationError({ model: "widget" }));
        }).pipe(Effect.retry(retryPolicy)),
      );

      expect(calls).toBe(1);
    }),
  );

  it.live("does not retry non-transient storage errors", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.exit(
        Effect.suspend(() => {
          calls++;
          return Effect.fail(
            new StorageError({
              message: "[storage-drizzle] findOne select failed: syntax error",
              cause: null,
            }),
          );
        }).pipe(Effect.retry(retryPolicy)),
      );

      expect(calls).toBe(1);
    }),
  );
});
