import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import type { ExecutionEngine } from "@executor-js/execution";
import { withExecutionUsageTracking } from "./execution-usage";

const makeBaseEngine = (): ExecutionEngine =>
  ({
    execute: () => Effect.succeed({ result: "ok", logs: [] }),
    executeWithPause: () =>
      Effect.succeed({
        status: "completed",
        result: { result: "ok", logs: [] },
      }),
    resume: () =>
      Effect.succeed({
        status: "completed",
        result: { result: "ok", logs: [] },
      }),
    getDescription: Effect.succeed("desc"),
  }) as ExecutionEngine;

describe("withExecutionUsageTracking", () => {
  it.effect("tracks successful execute and executeWithPause", () =>
    Effect.gen(function* () {
      const tracked: string[] = [];
      const trackedBoth = yield* Deferred.make<void>();
      const engine = withExecutionUsageTracking("org_1", makeBaseEngine(), (orgId) => {
        return Effect.sync(() => {
          tracked.push(orgId);
          return tracked.length === 2;
        }).pipe(
          Effect.flatMap((isComplete) =>
            isComplete ? Deferred.succeed(trackedBoth, undefined) : Effect.void,
          ),
        );
      });

      yield* engine.execute("1+1", { onElicitation: () => Effect.die("unused") });
      yield* engine.executeWithPause("2+2");
      yield* Deferred.await(trackedBoth);

      expect(tracked).toEqual(["org_1", "org_1"]);
    }),
  );

  it.effect("does not wait for usage tracking", () =>
    Effect.gen(function* () {
      const trackingStarted = yield* Deferred.make<void>();
      const trackingCanFinish = yield* Deferred.make<void>();
      const engine = withExecutionUsageTracking("org_1", makeBaseEngine(), () => {
        return Deferred.succeed(trackingStarted, undefined).pipe(
          Effect.andThen(Deferred.await(trackingCanFinish)),
        );
      });

      const result = yield* engine.execute("1+1", { onElicitation: () => Effect.die("unused") });
      yield* Deferred.await(trackingStarted);
      yield* Deferred.succeed(trackingCanFinish, undefined);

      expect(result).toEqual({ result: "ok", logs: [] });
    }),
  );

  it.effect("does not track resume usage", () =>
    Effect.gen(function* () {
      const tracked: string[] = [];
      const base = makeBaseEngine();

      let shouldReturnNull = false;
      const engine = withExecutionUsageTracking(
        "org_2",
        {
          ...base,
          resume: (...args) => {
            if (shouldReturnNull) return Effect.succeed(null);
            return base.resume(...args);
          },
        },
        (orgId) => {
          return Effect.sync(() => {
            tracked.push(orgId);
          });
        },
      );

      yield* engine.resume("exec_1", {
        action: "accept",
      });
      shouldReturnNull = true;
      yield* engine.resume("missing", {
        action: "accept",
      });

      expect(tracked).toEqual([]);
    }),
  );
});
