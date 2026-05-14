import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ExecutionFinished,
  ExecutionId,
  ScopeId,
  composeExecutionObservers,
  definePlugin,
} from "./index";

const firstPlugin = definePlugin(() => ({
  id: "first" as const,
  storage: () => ({}),
  extension: () => ({ label: "first" }),
  runtime: {
    executionObserver: (self) => ({
      handle: () => Effect.sync(() => calls.push(self.label)),
    }),
  },
}));

const failingPlugin = definePlugin(() => ({
  id: "failing" as const,
  storage: () => ({}),
  extension: () => ({ label: "failing" }),
  runtime: {
    executionObserver: () => ({
      handle: () => Effect.die("observer failed"),
    }),
  },
}));

const lastPlugin = definePlugin(() => ({
  id: "last" as const,
  storage: () => ({}),
  extension: () => ({ label: "last" }),
  runtime: {
    executionObserver: (self) => ({
      handle: () => Effect.sync(() => calls.push(self.label)),
    }),
  },
}));

let calls: string[] = [];

describe("composeExecutionObservers", () => {
  it.effect("composes plugin observers in order and isolates observer failures", () =>
    Effect.gen(function* () {
      calls = [];
      const first = firstPlugin();
      const failing = failingPlugin();
      const last = lastPlugin();
      const observer = composeExecutionObservers([first, failing, last] as const, {
        first: { label: "first" },
        failing: { label: "failing" },
        last: { label: "last" },
      });

      yield* observer.handle(
        new ExecutionFinished({
          executionId: ExecutionId.make("exec_test"),
          scopeId: ScopeId.make("scope_test"),
          status: "completed",
          result: "ok",
          completedAt: new Date(),
        }),
      );

      expect(calls).toEqual(["first", "last"]);
    }),
  );
});
