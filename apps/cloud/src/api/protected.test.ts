import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ExecutionEngine } from "@executor/execution";
import { withExecutionUsageTracking } from "./execution-usage";

const makeBaseEngine = (): ExecutionEngine =>
  ({
    execute: async () => ({ result: "ok", logs: [] }),
    executeWithPause: async () => ({
      status: "completed",
      result: { result: "ok", logs: [] },
    }),
    resume: async () => ({
      status: "completed",
      result: { result: "ok", logs: [] },
    }),
    getDescription: async () => "desc",
  }) as ExecutionEngine;

describe("withExecutionUsageTracking", () => {
  it.effect("tracks successful execute and executeWithPause", () =>
    Effect.gen(function* () {
      const tracked: string[] = [];
      const engine = withExecutionUsageTracking("org_1", makeBaseEngine(), (orgId) => {
        tracked.push(orgId);
      });

      yield* Effect.promise(() =>
        engine.execute("1+1", { onElicitation: (() => Effect.die("unused")) as never }),
      );
      yield* Effect.promise(() => engine.executeWithPause("2+2"));

      expect(tracked).toEqual(["org_1", "org_1"]);
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
          resume: async (...args) => {
            if (shouldReturnNull) return null;
            return base.resume(...args);
          },
        },
        (orgId) => {
          tracked.push(orgId);
        },
      );

      yield* Effect.promise(() =>
        engine.resume("exec_1", {
          action: "accept",
        }),
      );
      shouldReturnNull = true;
      yield* Effect.promise(() =>
        engine.resume("missing", {
          action: "accept",
        }),
      );

      expect(tracked).toEqual([]);
    }),
  );
});
