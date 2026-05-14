import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, Predicate } from "effect";

import {
  ElicitationResponse,
  FormElicitation,
  createExecutor,
  definePlugin,
  makeTestConfig,
  type ExecutionEvent,
  type ExecutionObserver,
} from "@executor-js/sdk";
import type { CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";

import { createExecutionEngine } from "./engine";

// Regression for the hang reported as the executor-MCP "180s timeout" against
// Cowork (Claude web). Cowork goes down the `executeWithPause` branch because
// it doesn't advertise managed elicitation. When the dynamic worker fails
// fast (e.g. user submits TS with a `:` type annotation, "Unexpected token
// ':'" inside ~25ms), the failure was swallowed and the request hung until
// the client gave up at 180s. The cause was `Effect.race` having
// prefer-success semantics in Effect v4: the racing pause-signal Deferred
// never resolves, so a fiber failure is never observed by the racer.

class FakeRuntimeError extends Data.TaggedError("FakeRuntimeError")<{
  readonly message: string;
}> {}

const failingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: () => Effect.fail(new FakeRuntimeError({ message: "Unexpected token ':'" })),
};

const succeedingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: () => Effect.succeed({ result: "ok", logs: [] } satisfies ExecuteResult),
};

const invokingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: (_code, invoker) =>
    Effect.gen(function* () {
      const result = yield* invoker
        .invoke({ path: "echo.ping", args: { message: "hello" } })
        .pipe(Effect.orDie);
      return { result, logs: ["called echo.ping"] } satisfies ExecuteResult;
    }),
};

const elicitingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: (_code, invoker) =>
    Effect.gen(function* () {
      const result = yield* invoker.invoke({ path: "forms.ask", args: {} }).pipe(Effect.orDie);
      return { result, logs: [] } satisfies ExecuteResult;
    }),
};

const emptyPlugin = definePlugin(() => ({
  id: "empty-test" as const,
  storage: () => ({}),
  staticSources: () => [],
}));

const echoPlugin = definePlugin(() => ({
  id: "echo-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "echo",
      kind: "in-memory",
      name: "Echo",
      tools: [
        {
          name: "ping",
          description: "Return the provided arguments",
          handler: ({ args }) => Effect.succeed({ ok: true, args }),
        },
      ],
    },
  ],
}));

const formsPlugin = definePlugin(() => ({
  id: "forms-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "forms",
      kind: "in-memory",
      name: "Forms",
      tools: [
        {
          name: "ask",
          description: "Ask for form input",
          handler: ({ elicit }) =>
            elicit(
              FormElicitation.make({
                message: "Approve this action",
                requestedSchema: {},
              }),
            ),
        },
      ],
    },
  ],
}));

const makeExecutor = () => createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));
const makeEchoExecutor = () => createExecutor(makeTestConfig({ plugins: [echoPlugin()] as const }));
const makeFormsExecutor = () =>
  createExecutor(makeTestConfig({ plugins: [formsPlugin()] as const }));

const collectEvents = (): {
  readonly events: ExecutionEvent[];
  readonly observer: ExecutionObserver;
} => {
  const events: ExecutionEvent[] = [];
  return {
    events,
    observer: {
      handle: (event) => Effect.sync(() => events.push(event)),
    },
  };
};

const eventKind = (event: ExecutionEvent): string => {
  if (Predicate.isTagged(event, "ExecutionStarted")) return "ExecutionStarted";
  if (Predicate.isTagged(event, "ToolCallStarted")) return "ToolCallStarted";
  if (Predicate.isTagged(event, "ToolCallFinished")) return "ToolCallFinished";
  if (Predicate.isTagged(event, "InteractionStarted")) return "InteractionStarted";
  if (Predicate.isTagged(event, "InteractionResolved")) return "InteractionResolved";
  return "ExecutionFinished";
};

describe("executeWithPause failure propagation", () => {
  it.effect("surfaces a fast codeExecutor failure as an Exit.Failure", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      const exit = yield* Effect.exit(engine.executeWithPause("noop"));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("does not hang when codeExecutor fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      // Race the executeWithPause against a short sleep. With the bug
      // present this resolves to "hung" because the failure is swallowed
      // by the prefer-success race against the pause Deferred.
      const outcome = yield* Effect.race(
        Effect.exit(engine.executeWithPause("noop")).pipe(
          Effect.map((exit) => ({ kind: "settled" as const, exit })),
        ),
        Effect.sleep("500 millis").pipe(Effect.as({ kind: "hung" as const })),
      );

      expect(outcome.kind).toBe("settled");
    }),
  );

  it.effect("control: succeedingExecutor returns completed", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: succeedingExecutor,
      });

      const result = yield* engine.executeWithPause("noop");
      expect(result.status).toBe("completed");
    }),
  );
});

describe("execution observers", () => {
  it.effect("emits ordered lifecycle events for a successful tool call", () =>
    Effect.gen(function* () {
      const executor = yield* makeEchoExecutor();
      const { events, observer } = collectEvents();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: invokingExecutor,
        observer,
      });

      const result = yield* engine.execute("call echo", {
        onElicitation: () => Effect.succeed(ElicitationResponse.make({ action: "accept" })),
        trigger: { kind: "test", metadata: { suite: "observer" } },
      });

      expect(result.error).toBeUndefined();
      expect(events.map(eventKind)).toEqual([
        "ExecutionStarted",
        "ToolCallStarted",
        "ToolCallFinished",
        "ExecutionFinished",
      ]);
      expect(events[0]).toMatchObject({
        _tag: "ExecutionStarted",
        code: "call echo",
        trigger: { kind: "test", metadata: { suite: "observer" } },
      });
      expect(events[1]).toMatchObject({ _tag: "ToolCallStarted", path: "echo.ping" });
      expect(events[2]).toMatchObject({
        _tag: "ToolCallFinished",
        path: "echo.ping",
        status: "completed",
      });
      expect(events[3]).toMatchObject({ _tag: "ExecutionFinished", status: "completed" });
    }),
  );

  it.effect("emits a failed terminal event when the code executor fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const { events, observer } = collectEvents();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
        observer,
      });

      const exit = yield* Effect.exit(
        engine.execute("bad code", {
          onElicitation: () => Effect.succeed(ElicitationResponse.make({ action: "accept" })),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(events.map(eventKind)).toEqual(["ExecutionStarted", "ExecutionFinished"]);
      expect(events[1]).toMatchObject({ _tag: "ExecutionFinished", status: "failed" });
    }),
  );

  it.effect("does not fail execution when an observer fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: succeedingExecutor,
        observer: {
          handle: () => Effect.die("observer failed"),
        },
      });

      const result = yield* engine.executeWithPause("noop");
      expect(result.status).toBe("completed");
    }),
  );

  it.effect("emits interaction events for pause and resume", () =>
    Effect.gen(function* () {
      const executor = yield* makeFormsExecutor();
      const { events, observer } = collectEvents();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: elicitingExecutor,
        observer,
      });

      const paused = yield* engine.executeWithPause("ask user");
      expect(paused.status).toBe("paused");
      if (paused.status !== "paused") {
        return;
      }

      const completed = yield* engine.resume(paused.execution.id, {
        action: "accept",
        content: { approved: true },
      });
      expect(completed?.status).toBe("completed");

      expect(events.map(eventKind)).toEqual([
        "ExecutionStarted",
        "ToolCallStarted",
        "InteractionStarted",
        "InteractionResolved",
        "ToolCallFinished",
        "ExecutionFinished",
      ]);
      expect(events[2]).toMatchObject({ _tag: "InteractionStarted" });
      expect(events[3]).toMatchObject({ _tag: "InteractionResolved", status: "accepted" });
    }),
  );
});
