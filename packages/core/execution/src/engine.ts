import { Deferred, Duration, Effect, Fiber, Metric, MetricBoundaries, Ref } from "effect";

import type {
  ExecutionInteractionId,
  Executor,
  InvokeOptions,
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
} from "@executor/sdk";
import { ExecutionId } from "@executor/sdk";
import { type CodeExecutor, type ExecuteResult, type SandboxToolInvoker, formatUnknownMessage } from "@executor/codemode-core";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";

type ExecutionStoreType = Executor["executions"];

import {
  makeExecutorToolInvoker,
  searchTools,
  listExecutorSources,
  describeTool,
} from "./tool-invoker";
import { ExecutionToolError } from "./errors";
import { buildExecuteDescription } from "./description";

export type ExecutionEngineConfig = {
  readonly executor: Executor;
  readonly codeExecutor?: CodeExecutor;
  readonly executionStore?: Executor["executions"];
  /**
   * Custom effect runner, e.g. `managedRuntime.runPromise` with an OTel
   * tracer layer. When omitted, `Effect.runPromise` is used (no-op tracer).
   */
  readonly runPromise?: <A>(effect: Effect.Effect<A, never>) => Promise<A>;
};

export type ExecutionResult =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "paused"; readonly execution: PausedExecution };

export type PausedExecution = {
  readonly id: string;
  readonly elicitationContext: ElicitationContext;
};

type InternalPausedExecution = PausedExecution & {
  readonly interactionId: ExecutionInteractionId;
  readonly response: Deferred.Deferred<typeof ElicitationResponse.Type>;
  readonly fiber: Fiber.Fiber<ExecuteResult, unknown>;
  readonly pauseSignalRef: Ref.Ref<Deferred.Deferred<InternalPausedExecution>>;
};

export type ResumeResponse = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
};

/** Entry point that triggered this execution. */
export type ExecutionTrigger = {
  readonly kind: string;
  readonly meta?: Record<string, unknown>;
};

type ToolCallRecordingContext = {
  readonly executionId: ExecutionId;
  readonly executionStore: ExecutionStoreType;
  readonly counter: Ref.Ref<number>;
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const executionOutcomes = Metric.counter("executor.execution.outcomes", {
  description: "Execution outcome counts",
});

const executionDuration = Metric.histogram(
  "executor.execution.duration_ms",
  MetricBoundaries.exponential({ start: 10, factor: 2, count: 15 }),
  "Execution duration distribution in milliseconds",
);

const toolCallCounter = Metric.counter("executor.tool_calls", {
  description: "Number of tool invocations",
});

const toolCallDuration = Metric.histogram(
  "executor.tool_call.duration_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 12 }),
  "Tool call duration distribution in milliseconds",
);

// ---------------------------------------------------------------------------

const MAX_PREVIEW_CHARS = 30_000;

const truncate = (value: string, max: number): string =>
  value.length > max
    ? `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`
    : value;

export const formatExecuteResult = (
  result: ExecuteResult,
): {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
} => {
  const resultText =
    result.result != null
      ? typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2)
      : null;

  const logText = result.logs && result.logs.length > 0 ? result.logs.join("\n") : null;

  if (result.error) {
    const parts = [`Error: ${result.error}`, ...(logText ? [`\nLogs:\n${logText}`] : [])];
    return {
      text: truncate(parts.join("\n"), MAX_PREVIEW_CHARS),
      structured: { status: "error", error: result.error, logs: result.logs ?? [] },
      isError: true,
    };
  }

  const parts = [
    ...(resultText ? [truncate(resultText, MAX_PREVIEW_CHARS)] : ["(no result)"]),
    ...(logText ? [`\nLogs:\n${logText}`] : []),
  ];
  return {
    text: parts.join("\n"),
    structured: { status: "completed", result: result.result ?? null, logs: result.logs ?? [] },
    isError: false,
  };
};

export const formatPausedExecution = (
  paused: PausedExecution,
): {
  text: string;
  structured: Record<string, unknown>;
} => {
  const req = paused.elicitationContext.request;
  const lines: string[] = [`Execution paused: ${req.message}`];

  if (req._tag === "UrlElicitation") {
    lines.push(`\nOpen this URL in a browser:\n${req.url}`);
    lines.push("\nAfter the browser flow, resume with the executionId below:");
  } else {
    lines.push("\nResume with the executionId below and a response matching the requested schema:");
    const schema = req.requestedSchema;
    if (schema && Object.keys(schema).length > 0) {
      lines.push(`\nRequested schema:\n${JSON.stringify(schema, null, 2)}`);
    }
  }

  lines.push(`\nexecutionId: ${paused.id}`);

  return {
    text: lines.join("\n"),
    structured: {
      status: "waiting_for_interaction",
      executionId: paused.id,
      interaction: {
        kind: req._tag === "UrlElicitation" ? "url" : "form",
        message: req.message,
        ...(req._tag === "UrlElicitation" ? { url: req.url } : {}),
        ...(req._tag === "FormElicitation" ? { requestedSchema: req.requestedSchema } : {}),
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Full invoker (base + discover + describe)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serializeJson = (value: unknown): string | null => {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
};

const serializeLogs = (logs: readonly string[] | undefined): string | null =>
  logs && logs.length > 0 ? JSON.stringify(logs) : null;

const buildInteractionPayload = (ctx: ElicitationContext) => {
  const req = ctx.request;
  return {
    kind: req._tag === "UrlElicitation" ? "url" : "form",
    purpose: req.message,
    payloadJson: JSON.stringify({
      message: req.message,
      kind: req._tag === "UrlElicitation" ? "url" : "form",
      ...(req._tag === "UrlElicitation" ? { url: req.url } : {}),
      ...(req._tag === "FormElicitation" ? { requestedSchema: req.requestedSchema } : {}),
    }),
  };
};

const readOptionalLimit = (value: unknown, toolName: string): number | ExecutionToolError => {
  if (value === undefined) {
    return 12;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return new ExecutionToolError({
      message: `${toolName} limit must be a positive number when provided`,
    });
  }

  return Math.floor(value);
};

const withToolCallRecording = (
  base: SandboxToolInvoker,
  recording: ToolCallRecordingContext,
  path: string,
  args: unknown,
): Effect.Effect<unknown, unknown> => {
  const namespace = path.includes(".") ? path.split(".")[0]! : path;

  return Effect.gen(function* () {
    const { executionId, executionStore, counter } = recording;
    const startedAt = Date.now();
    const argsJson = serializeJson(args);

    yield* Ref.update(counter, (n) => n + 1);
    yield* Metric.update(Metric.tagged(Metric.tagged(toolCallCounter, "tool_path", path), "namespace", namespace), 1);

    const toolCall = yield* executionStore.recordToolCall({
      executionId,
      status: "running",
      toolPath: path,
      namespace,
      argsJson,
      resultJson: null,
      errorText: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    });

    return yield* base.invoke({ path, args }).pipe(
      Effect.tap((value) =>
        Effect.gen(function* () {
          const completedAt = Date.now();
          const durationMs = Math.max(0, completedAt - startedAt);
          yield* Metric.update(toolCallDuration, durationMs);
          yield* Effect.annotateCurrentSpan("executor.tool.result_size", serializeJson(value)?.length ?? 0);
          yield* executionStore.finishToolCall(toolCall.id, {
            status: "completed",
            resultJson: serializeJson(value),
            errorText: null,
            completedAt,
            durationMs,
          });
        }),
      ),
      Effect.tapError((cause) =>
        Effect.gen(function* () {
          const completedAt = Date.now();
          const durationMs = Math.max(0, completedAt - startedAt);
          yield* Metric.update(toolCallDuration, durationMs);
          const errorText = formatUnknownMessage(cause);
          yield* Effect.annotateCurrentSpan("executor.tool.error", errorText);
          yield* executionStore.finishToolCall(toolCall.id, {
            status: "failed",
            resultJson: null,
            errorText,
            completedAt,
            durationMs,
          });
        }),
      ),
    );
  }).pipe(
    Effect.withSpan(`executor.tool.${path}`, {
      attributes: {
        "executor.tool.path": path,
        "executor.tool.namespace": namespace,
        "executor.execution.id": recording.executionId,
      },
    }),
  );
};

const makeFullInvoker = (
  executor: Executor,
  invokeOptions: InvokeOptions,
  recording?: ToolCallRecordingContext,
): SandboxToolInvoker => {
  const base = makeExecutorToolInvoker(executor, { invokeOptions });
  return {
    invoke: ({ path, args }) => {
      if (path === "search") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.search expects an object: { query?: string; namespace?: string; limit?: number }",
            }),
          );
        }

        if (args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search query must be a string when provided",
            }),
          );
        }

        if (args.namespace !== undefined && typeof args.namespace !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search namespace must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(args.limit, "tools.search");
        if (limit instanceof ExecutionToolError) {
          return Effect.fail(limit);
        }

        return searchTools(executor, args.query ?? "", limit, {
          namespace: args.namespace,
        });
      }
      if (path === "executor.sources.list") {
        if (args !== undefined && !isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.executor.sources.list expects an object: { query?: string; limit?: number }",
            }),
          );
        }

        if (isRecord(args) && args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.executor.sources.list query must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(
          isRecord(args) ? args.limit : undefined,
          "tools.executor.sources.list",
        );
        if (limit instanceof ExecutionToolError) {
          return Effect.fail(limit);
        }

        return listExecutorSources(executor, {
          query: isRecord(args) && typeof args.query === "string" ? args.query : undefined,
          limit,
        });
      }
      if (path === "describe.tool") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.describe.tool expects an object: { path: string }",
            }),
          );
        }

        if (typeof args.path !== "string" || args.path.trim().length === 0) {
          return Effect.fail(new ExecutionToolError({ message: "describe.tool requires a path" }));
        }

        if ("includeSchemas" in args) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.describe.tool no longer accepts includeSchemas",
            }),
          );
        }

        return describeTool(executor, args.path);
      }
      // Only record user-facing tool calls; search/describe/sources.list are engine plumbing.
      if (recording) {
        return withToolCallRecording(base, recording, path, args);
      }
      return base.invoke({ path, args });
    },
  };
};

export type ExecutionEngine = {
  /**
   * Execute code with elicitation handled inline by the provided handler.
   * Use this when the host supports elicitation (e.g. MCP with elicitation capability).
   *
   * `options.trigger` identifies the entry point (HTTP / MCP / CLI / …)
   * and gets written to the execution record for facet filtering.
   */
  readonly execute: (
    code: string,
    options: {
      readonly onElicitation: ElicitationHandler;
      readonly trigger?: ExecutionTrigger;
    },
  ) => Promise<ExecuteResult>;

  /**
   * Execute code, intercepting the first elicitation as a pause point.
   * Use this when the host doesn't support inline elicitation.
   * Returns either a completed result or a paused execution that can be resumed.
   */
  readonly executeWithPause: (
    code: string,
    options?: { readonly trigger?: ExecutionTrigger },
  ) => Promise<ExecutionResult>;

  /**
   * Resume a paused execution. Returns a completed result, a new pause, or
   * null if the executionId was not found.
   */
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Promise<ExecutionResult | null>;

  /**
   * Get the dynamic tool description (workflow + namespaces).
   */
  readonly getDescription: () => Promise<string>;
};

export const createExecutionEngine = (config: ExecutionEngineConfig): ExecutionEngine => {
  const { executor } = config;
  const codeExecutor = config.codeExecutor ?? makeQuickJsExecutor();
  const executionStore = config.executionStore ?? executor.executions;
  const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
    config.runPromise
      ? config.runPromise(effect as Effect.Effect<A, never>)
      : Effect.runPromise(effect as Effect.Effect<A, never>);
  const pausedExecutions = new Map<string, InternalPausedExecution>();
  // Per-execution tool-call counter shared with the invoker wrapper and
  // read when persisting terminal state. Kept outside the InternalPaused
  // record so `resume()` can still update the same counter across the
  // pause/resume boundary.
  const pausedCounters = new Map<string, Ref.Ref<number>>();

  const persistTerminalState = (
    executionId: ExecutionId,
    result: ExecuteResult,
    counter: Ref.Ref<number>,
  ): Effect.Effect<ExecuteResult> =>
    Effect.gen(function* () {
      const now = Date.now();
      const toolCallCount = yield* Ref.get(counter);
      const status = result.error ? "failed" : "completed";
      yield* Metric.update(Metric.tagged(executionOutcomes, "status", status), 1);
      yield* Effect.annotateCurrentSpan({
        "executor.execution.status": status,
        "executor.execution.tool_call_count": toolCallCount,
      });
      yield* executionStore.update(executionId, {
        status,
        resultJson: serializeJson(result.result),
        errorText: result.error ?? null,
        logsJson: serializeLogs(result.logs),
        completedAt: now,
        toolCallCount,
        updatedAt: now,
      });
      return result;
    });

  const createExecutionRecord = (code: string, trigger: ExecutionTrigger | undefined) => {
    const triggerMetaJson = (() => {
      if (!trigger?.meta) return null;
      try {
        return JSON.stringify(trigger.meta);
      } catch {
        return null;
      }
    })();
    return executionStore.create({
      scopeId: executor.scope.id,
      status: "running",
      code,
      resultJson: null,
      errorText: null,
      logsJson: null,
      startedAt: Date.now(),
      completedAt: null,
      triggerKind: trigger?.kind ?? null,
      triggerMetaJson,
      toolCallCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  /**
   * Race a running fiber against a pause signal. Returns when either
   * the fiber completes or an elicitation handler fires (whichever
   * comes first). Re-used by both executeWithPause and resume.
   */
  const awaitCompletionOrPause = (
    executionId: ExecutionId,
    fiber: Fiber.Fiber<ExecuteResult, unknown>,
    pauseSignal: Deferred.Deferred<InternalPausedExecution>,
    counter: Ref.Ref<number>,
  ): Effect.Effect<ExecutionResult> =>
    Effect.race(
      Fiber.join(fiber).pipe(
        Effect.orDie,
        Effect.flatMap((result) => persistTerminalState(executionId, result, counter)),
        Effect.map((result): ExecutionResult => ({ status: "completed", result })),
      ),
      Deferred.await(pauseSignal).pipe(
        Effect.map((paused): ExecutionResult => ({ status: "paused", execution: paused })),
      ),
    );

  /**
   * Start an execution in pause/resume mode.
   *
   * The sandbox is forked as a daemon because paused executions can outlive the
   * caller scope that returned the first pause, such as an HTTP request handler.
   */
  const startPausableExecution = (
    code: string,
    trigger: ExecutionTrigger | undefined,
  ): Effect.Effect<ExecutionResult> =>
    Effect.gen(function* () {
      const execution = yield* createExecutionRecord(code, trigger);

      yield* Effect.annotateCurrentSpan({
        "executor.execution.id": execution.id,
        "executor.scope.id": executor.scope.id,
        "executor.trigger.kind": trigger?.kind ?? "unknown",
      });

      // Counter shared by the invoker wrapper and persistTerminalState.
      const counter = yield* Ref.make(0);

      // Ref holds the current pause signal. The elicitation handler reads
      // it each time it fires, so resume() can swap in a fresh Deferred
      // before unblocking the fiber.
      const pauseSignalRef = yield* Ref.make(yield* Deferred.make<InternalPausedExecution>());

      // Will be set once the fiber is forked.
      let fiber: Fiber.Fiber<ExecuteResult, unknown>;

      const elicitationHandler: ElicitationHandler = (ctx) =>
        Effect.gen(function* () {
          const now = Date.now();
          const responseDeferred = yield* Deferred.make<typeof ElicitationResponse.Type>();
          const interactionPayload = buildInteractionPayload(ctx);
          const interaction = yield* executionStore.recordInteraction(execution.id, {
            executionId: execution.id,
            status: "pending",
            kind: interactionPayload.kind,
            purpose: interactionPayload.purpose,
            payloadJson: interactionPayload.payloadJson,
            responseJson: null,
            responsePrivateJson: null,
            createdAt: now,
            updatedAt: now,
          });
          yield* executionStore.update(execution.id, {
            status: "waiting_for_interaction",
            updatedAt: now,
          });
          yield* Effect.annotateCurrentSpan("executor.interaction.kind", interactionPayload.kind);

          const paused: InternalPausedExecution = {
            id: execution.id,
            elicitationContext: ctx,
            interactionId: interaction.id,
            response: responseDeferred,
            fiber: fiber!,
            pauseSignalRef,
          };
          pausedExecutions.set(execution.id, paused);

          const currentSignal = yield* Ref.get(pauseSignalRef);
          yield* Deferred.succeed(currentSignal, paused);

          // Suspend until resume() completes responseDeferred.
          return yield* Deferred.await(responseDeferred);
        });

      const invoker = makeFullInvoker(
        executor,
        { onElicitation: elicitationHandler },
        { executionId: execution.id, executionStore, counter },
      );
      fiber = yield* Effect.forkDaemon(codeExecutor.execute(code, invoker));

      // Stash the counter on the paused record so resume() can also
      // reuse it (so the second half of the run also records tool calls
      // against the same total).
      pausedCounters.set(execution.id, counter);

      const initialSignal = yield* Ref.get(pauseSignalRef);
      return yield* awaitCompletionOrPause(execution.id, fiber, initialSignal, counter);
    }).pipe(
      Effect.withSpan("executor.execution"),
      Metric.trackDurationWith(executionDuration, (d) => Duration.toMillis(d)),
    );

  const executeWithManagedRecording = (
    code: string,
    onElicitation: ElicitationHandler,
    trigger: ExecutionTrigger | undefined,
  ): Effect.Effect<ExecuteResult> =>
    Effect.gen(function* () {
      const execution = yield* createExecutionRecord(code, trigger);
      const counter = yield* Ref.make(0);

      yield* Effect.annotateCurrentSpan({
        "executor.execution.id": execution.id,
        "executor.scope.id": executor.scope.id,
        "executor.trigger.kind": trigger?.kind ?? "unknown",
      });

      const recordingHandler: ElicitationHandler = (ctx) =>
        Effect.gen(function* () {
          const now = Date.now();
          const interactionPayload = buildInteractionPayload(ctx);
          const interaction = yield* executionStore.recordInteraction(execution.id, {
            executionId: execution.id,
            status: "pending",
            kind: interactionPayload.kind,
            purpose: interactionPayload.purpose,
            payloadJson: interactionPayload.payloadJson,
            responseJson: null,
            responsePrivateJson: null,
            createdAt: now,
            updatedAt: now,
          });
          yield* executionStore.update(execution.id, {
            status: "waiting_for_interaction",
            updatedAt: now,
          });
          yield* Effect.annotateCurrentSpan("executor.interaction.kind", interactionPayload.kind);

          const response = yield* onElicitation(ctx);
          yield* executionStore.resolveInteraction(interaction.id, {
            status: response.action === "accept" ? "resolved" : "cancelled",
            responseJson: serializeJson({
              action: response.action,
              content: response.content ?? null,
            }),
            updatedAt: Date.now(),
          });
          yield* executionStore.update(execution.id, {
            status: "running",
            updatedAt: Date.now(),
          });
          return response;
        });

      const invoker = makeFullInvoker(
        executor,
        { onElicitation: recordingHandler },
        { executionId: execution.id, executionStore, counter },
      );
      const result = yield* codeExecutor.execute(code, invoker).pipe(Effect.orDie);
      return yield* persistTerminalState(execution.id, result, counter);
    }).pipe(
      Effect.withSpan("executor.execution"),
      Metric.trackDurationWith(executionDuration, (d) => Duration.toMillis(d)),
    );

  /**
   * Resume a paused execution. Swaps in a fresh pause signal, completes
   * the response Deferred to unblock the fiber, then races completion
   * against the next pause.
   */
  const resumeExecution = (
    executionId: ExecutionId,
    response: ResumeResponse,
  ): Effect.Effect<ExecutionResult | null> =>
    Effect.gen(function* () {
      const paused = pausedExecutions.get(executionId);
      if (!paused) return null;
      pausedExecutions.delete(executionId);
      // Look up the counter for this paused run. Should exist because
      // startPausableExecution always registers one. Fall back to a
      // fresh counter just in case (keeps the engine from crashing).
      const counter = pausedCounters.get(executionId) ?? (yield* Ref.make(0));

      yield* Effect.annotateCurrentSpan({
        "executor.execution.id": executionId,
        "executor.resume.action": response.action,
      });

      const now = Date.now();
      yield* executionStore.resolveInteraction(paused.interactionId, {
        status: response.action === "accept" ? "resolved" : "cancelled",
        responseJson: serializeJson({
          action: response.action,
          content: response.content ?? null,
        }),
        updatedAt: now,
      });

      if (response.action !== "accept") {
        const toolCallCount = yield* Ref.get(counter);
        yield* Effect.annotateCurrentSpan("executor.execution.status", "cancelled");
        yield* executionStore.update(executionId, {
          status: "cancelled",
          completedAt: now,
          toolCallCount,
          updatedAt: now,
        });
        pausedCounters.delete(executionId);
        yield* Fiber.interrupt(paused.fiber);
        return {
          status: "completed" as const,
          result: {
            result: null,
            error: "Execution cancelled by user",
            logs: [],
          },
        };
      }

      // Swap in a fresh pause signal BEFORE unblocking the fiber, so the
      // next elicitation handler call signals this new Deferred.
      const nextSignal = yield* Deferred.make<InternalPausedExecution>();
      yield* Ref.set(paused.pauseSignalRef, nextSignal);
      yield* executionStore.update(executionId, {
        status: "running",
        updatedAt: now,
      });

      yield* Deferred.succeed(paused.response, {
        action: response.action,
        content: response.content,
      });

      const outcome = yield* awaitCompletionOrPause(executionId, paused.fiber, nextSignal, counter);
      if (outcome.status === "completed") {
        pausedCounters.delete(executionId);
      }
      return outcome;
    }).pipe(
      Effect.withSpan("executor.execution.resume"),
    );

  const annotate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.annotateSpans("module", "ExecutionEngine"));

  return {
    execute: (code, options) =>
      runEffect(annotate(executeWithManagedRecording(code, options.onElicitation, options.trigger))),

    executeWithPause: (code, options) =>
      runEffect(annotate(startPausableExecution(code, options?.trigger))),

    resume: (executionId, response) =>
      runEffect(annotate(resumeExecution(ExecutionId.make(executionId), response))),

    getDescription: () => runEffect(buildExecuteDescription(executor)),
  };
};
