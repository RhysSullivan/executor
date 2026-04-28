// ---------------------------------------------------------------------------
// Edge translation — `StorageError → InternalError(traceId)` behaviour
// via `capture(eff)`. Handlers wrap their generator bodies with
// `capture(...)`; this file exercises the translator in isolation.
// ErrorCapture is optional — absent hosts just get empty trace ids.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Ref } from "effect";
import { StorageError, UniqueViolationError } from "@executor/storage-core";

import { capture, ErrorCapture, InternalError } from "./observability";

// Recording ErrorCapture — returns a fixed trace id and accumulates
// every cause it sees in a Ref.
const makeRecorder = (traceId = "trace-xyz") =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Cause.Cause<unknown>>>([]);
    const layer = Layer.succeed(
      ErrorCapture,
      ErrorCapture.of({
        captureException: (cause) =>
          Ref.update(seen, (prev) => [...prev, cause]).pipe(
            Effect.as(traceId),
          ),
      }),
    );
    return { layer, seen };
  });

describe("capture", () => {
  it.effect("translates StorageError to InternalError with ErrorCapture trace id", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* makeRecorder("trace-abc");
      const err = new StorageError({ message: "db down", cause: new Error("x") });

      const eff = capture(Effect.fail(err));
      const result = yield* Effect.flip(eff).pipe(Effect.provide(layer));

      expect(result).toBeInstanceOf(InternalError);
      expect(result.traceId).toBe("trace-abc");

      // The recorder saw exactly one cause carrying the original StorageError.
      const causes = yield* Ref.get(seen);
      expect(causes.length).toBe(1);
      const squashed = Cause.squash(causes[0]!) as StorageError;
      expect(squashed).toBeInstanceOf(StorageError);
      expect(squashed.message).toBe("db down");
    }),
  );

  it.effect("empty traceId when no ErrorCapture is wired", () =>
    Effect.gen(function* () {
      const err = new StorageError({ message: "nope", cause: undefined });
      const result = yield* Effect.flip(capture(Effect.fail(err)));
      expect(result).toBeInstanceOf(InternalError);
      expect(result.traceId).toBe("");
    }),
  );

  it.effect("UniqueViolationError dies (becomes a defect — plugins should catchTag before returning)", () =>
    Effect.gen(function* () {
      const err = new UniqueViolationError({ model: "thing" });
      const exit = yield* Effect.exit(capture(Effect.fail(err)));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const defects = Cause.defects(exit.cause);
        expect(Array.from(defects)[0]).toBeInstanceOf(UniqueViolationError);
      }
    }),
  );

  it.effect("non-storage typed failures pass through unchanged", () =>
    Effect.gen(function* () {
      class DomainError {
        readonly _tag = "DomainError" as const;
      }
      const eff = Effect.fail(new DomainError()) as Effect.Effect<
        never,
        DomainError
      >;
      const result = yield* Effect.flip(capture(eff));
      expect(result._tag).toBe("DomainError");
    }),
  );
});

