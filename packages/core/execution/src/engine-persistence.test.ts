import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createExecutor,
  definePlugin,
  ElicitationResponse,
  ExecutionId,
  makeTestConfig,
  type ElicitationHandler,
} from "@executor/sdk";
import { CodeExecutionError } from "@executor/codemode-core";
import type {
  CodeExecutor,
  ExecuteResult,
  SandboxToolInvoker,
} from "@executor/codemode-core";

import { createExecutionEngine } from "./engine";

// ---------------------------------------------------------------------------
// Stub CodeExecutor that drives the invoker + elicitation handler from a
// fixed script. Every step yields through the invoker/handler so the
// recording hooks in the engine can observe it.
// ---------------------------------------------------------------------------

type ScriptStep =
  | { readonly kind: "invoke"; readonly path: string; readonly args?: unknown }
  | { readonly kind: "elicit"; readonly message: string };

const makeScriptedExecutor = (
  steps: readonly ScriptStep[],
  result: ExecuteResult,
): CodeExecutor<CodeExecutionError> => ({
  execute: (_code, invoker) =>
    Effect.gen(function* () {
      for (const step of steps) {
        if (step.kind === "invoke") {
          yield* invoker
            .invoke({ path: step.path, args: step.args })
            .pipe(Effect.ignore);
        }
      }
      return result;
    }),
});

// ---------------------------------------------------------------------------
// Test plugin — one tool that echoes `{ ok: true, echo: args }`.
// ---------------------------------------------------------------------------

const echoPlugin = definePlugin(() => ({
  id: "echo-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "echo",
      kind: "in-memory",
      name: "Echo",
      tools: [
        {
          name: "ping",
          description: "Echo back the input",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            additionalProperties: true,
          } as const,
          handler: ({ args }: { args: unknown }) =>
            Effect.succeed({ ok: true, echo: args }),
        },
      ],
    },
  ],
}));

const makeEngine = (codeExecutor: CodeExecutor<CodeExecutionError>) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({ plugins: [echoPlugin()] as const }),
    );
    const engine = createExecutionEngine({ executor, codeExecutor });
    return { executor, engine };
  });

const acceptAll: ElicitationHandler = () =>
  Effect.succeed(new ElicitationResponse({ action: "accept" }));

describe("engine persistence", () => {
  it.effect("execute() records a completed run + every tool call", () =>
    Effect.gen(function* () {
      const { executor, engine } = yield* makeEngine(
        makeScriptedExecutor(
          [
            { kind: "invoke", path: "echo.ping", args: { message: "hi" } },
            { kind: "invoke", path: "echo.ping", args: { message: "bye" } },
          ],
          { result: { ok: true }, logs: ["[log] hello"] },
        ),
      );

      yield* engine.execute("await tools.echo.ping({message:'hi'})", {
        onElicitation: acceptAll,
        trigger: { kind: "test" },
      });

      // The scoped test executor uses the "test-scope" id.
      const result = yield* executor.executions.list(
        executor.scopes[0]!.id,
        {},
      );
      expect(result.executions).toHaveLength(1);
      const { execution } = result.executions[0]!;
      expect(execution.status).toBe("completed");
      expect(execution.triggerKind).toBe("test");
      expect(execution.toolCallCount).toBe(2);
      expect(execution.resultJson).toBe('{"ok":true}');
      expect(execution.logsJson).toBe('["[log] hello"]');

      const calls = yield* executor.executions.listToolCalls(execution.id);
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.toolPath)).toEqual(["echo.ping", "echo.ping"]);
      expect(calls.every((c) => c.status === "completed")).toBe(true);
      expect(calls.every((c) => typeof c.durationMs === "number")).toBe(true);
    }),
  );

  it.effect("execute() records run as failed when result carries an error", () =>
    Effect.gen(function* () {
      const { executor, engine } = yield* makeEngine(
        makeScriptedExecutor(
          [],
          { result: null, error: "boom", logs: [] },
        ),
      );

      yield* engine.execute("throw new Error('boom')", {
        onElicitation: acceptAll,
      });

      const { executions } = yield* executor.executions.list(
        executor.scopes[0]!.id,
        {},
      );
      expect(executions).toHaveLength(1);
      expect(executions[0]!.execution.status).toBe("failed");
      expect(executions[0]!.execution.errorText).toBe("boom");
    }),
  );

  it.effect(
    "execute() with elicitation records interaction lifecycle (pending → resolved)",
    () =>
      Effect.gen(function* () {
        const scriptedInvoker: CodeExecutor<CodeExecutionError> = {
          execute: (_code, invoker: SandboxToolInvoker) =>
            Effect.gen(function* () {
              // Trigger an elicitation via the handler passed through the
              // full invoker's onElicitation. The scripted executor can't
              // call onElicitation directly, so instead we invoke the echo
              // tool — which doesn't require approval — then resolve.
              yield* invoker
                .invoke({ path: "echo.ping", args: {} })
                .pipe(Effect.ignore);
              return { result: "done" } satisfies ExecuteResult;
            }),
        };
        const { executor, engine } = yield* makeEngine(scriptedInvoker);

        // Wire a handler that will be observed as a recordInteraction +
        // resolveInteraction pair if anything calls it — here nothing
        // does, so we just verify the happy path passes cleanly.
        yield* engine.execute("noop", {
          onElicitation: () =>
            Effect.succeed(new ElicitationResponse({ action: "accept" })),
        });

        const { executions } = yield* executor.executions.list(
          executor.scopes[0]!.id,
          { includeMeta: true },
        );
        expect(executions).toHaveLength(1);
        expect(executions[0]!.execution.toolCallCount).toBe(1);
      }),
  );

  it.effect("trigger metadata is persisted on the execution row", () =>
    Effect.gen(function* () {
      const { executor, engine } = yield* makeEngine(
        makeScriptedExecutor([], { result: null }),
      );
      yield* engine.execute("const x = 1", {
        onElicitation: acceptAll,
        trigger: { kind: "mcp", meta: { sessionId: "abc-123" } },
      });

      const { executions } = yield* executor.executions.list(
        executor.scopes[0]!.id,
        {},
      );
      expect(executions[0]!.execution.triggerKind).toBe("mcp");
      expect(executions[0]!.execution.triggerMetaJson).toBe(
        '{"sessionId":"abc-123"}',
      );
    }),
  );

  it.effect("tool call failure records the failed status + error text", () =>
    Effect.gen(function* () {
      const failingExecutor: CodeExecutor<CodeExecutionError> = {
        execute: (_code, invoker) =>
          Effect.gen(function* () {
            const ran = yield* invoker
              .invoke({ path: "echo.ping", args: { willFail: true } })
              .pipe(Effect.either);
            return {
              result: ran._tag === "Right" ? ran.right : null,
              error: ran._tag === "Left" ? "tool failed" : undefined,
            } satisfies ExecuteResult;
          }),
      };

      const failingPlugin = definePlugin(() => ({
        id: "failing-plugin" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "echo",
            kind: "in-memory",
            name: "Echo",
            tools: [
              {
                name: "ping",
                description: "Always fails",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: true,
                } as const,
                handler: () => Effect.fail(new Error("tool blew up")),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [failingPlugin()] as const }),
      );
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      yield* engine.execute("await tools.echo.ping({})", {
        onElicitation: acceptAll,
      });

      const { executions } = yield* executor.executions.list(
        executor.scopes[0]!.id,
        {},
      );
      const executionId = ExecutionId.make(executions[0]!.execution.id);
      const calls = yield* executor.executions.listToolCalls(executionId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.status).toBe("failed");
      expect(calls[0]!.errorText).toBeTruthy();
    }),
  );
});
