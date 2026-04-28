import { Cause as EffectCause, Deferred, Effect, Fiber, Ref } from "effect";
import type * as Cause from "effect/Cause";

import {
  ExecutionId,
  ExecutionInteractionId,
  ExecutionToolCallId,
  type ElicitationContext,
  type ElicitationHandler,
  type ElicitationResponse,
  type Executor,
  type InvokeOptions,
} from "@executor/sdk";
import { CodeExecutionError } from "@executor/codemode-core";
import type { CodeExecutor, ExecuteResult, SandboxToolInvoker } from "@executor/codemode-core";

import {
  makeExecutorToolInvoker,
  searchTools,
  listExecutorSources,
  describeTool,
} from "./tool-invoker";
import { ExecutionToolError } from "./errors";
import { buildExecuteDescription } from "./description";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEngineConfig<
  E extends Cause.YieldableError = CodeExecutionError,
> = {
  readonly executor: Executor;
  readonly codeExecutor: CodeExecutor<E>;
};

export type ExecutionResult =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "paused"; readonly execution: PausedExecution };

export type PausedExecution = {
  readonly id: string;
  readonly elicitationContext: ElicitationContext;
};

/** Trigger metadata — what surface started this run. Persisted on the
 *  execution row; filter facets in the runs UI read from it. */
export type ExecutionTrigger = {
  readonly kind: string;
  readonly meta?: Record<string, unknown>;
};

/** Internal representation with Effect runtime state for pause/resume. */
type InternalPausedExecution<E> = PausedExecution & {
  readonly response: Deferred.Deferred<typeof ElicitationResponse.Type>;
  readonly fiber: Fiber.Fiber<ExecuteResult, E>;
  readonly pauseSignalRef: Ref.Ref<Deferred.Deferred<InternalPausedExecution<E>>>;
  readonly interactionId: ExecutionInteractionId;
};

export type ResumeResponse = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Result formatting
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
// Recording helpers — serialize payloads for the execution_* tables
// without throwing on cyclic/unserializable values.
// ---------------------------------------------------------------------------

/** Best-effort wrapper for execution-history writes. Absorbs both typed
 *  failures AND defects (e.g. a backend adapter that throws synchronously
 *  for an unknown model before the app-level Drizzle schema has been
 *  migrated), so bookkeeping can never fail a tool call or a user
 *  execution. A caller that wants to know about these errors should
 *  inspect Axiom spans or add their own tracer. */
const silent = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  effect.pipe(Effect.catchAllCause(() => Effect.void));

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return safeStringify(err);
};

const formatCauseMessage = (cause: Cause.Cause<unknown>): string =>
  formatErrorMessage(EffectCause.squash(cause));

const serializeElicitationRequest = (ctx: ElicitationContext) => {
  const req = ctx.request;
  return req._tag === "UrlElicitation"
    ? { kind: "url", message: req.message, url: req.url }
    : {
        kind: "form",
        message: req.message,
        requestedSchema: req.requestedSchema,
      };
};

// ---------------------------------------------------------------------------
// Full invoker (base + discover + describe)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const makeFullInvoker = (executor: Executor, invokeOptions: InvokeOptions): SandboxToolInvoker => {
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
        }).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: { "mcp.tool.name": path, "executor.tool.builtin": true },
          }),
        );
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
        }).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: { "mcp.tool.name": path, "executor.tool.builtin": true },
          }),
        );
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

        return describeTool(executor, args.path).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: {
              "mcp.tool.name": path,
              "executor.tool.builtin": true,
              "executor.tool.target_path": args.path,
            },
          }),
        );
      }
      return base.invoke({ path, args });
    },
  };
};

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export type ExecutionEngine<E extends Cause.YieldableError = CodeExecutionError> = {
  /**
   * Execute code with elicitation handled inline by the provided handler.
   * Use this when the host supports elicitation (e.g. MCP with elicitation capability).
   *
   * Fails with the code executor's typed error `E` (defaults to
   * `CodeExecutionError`). Runtimes surface their own `Data.TaggedError`
   * subclass, which flows through here unchanged.
   */
  readonly execute: (
    code: string,
    options: {
      readonly onElicitation: ElicitationHandler;
      readonly trigger?: ExecutionTrigger;
    },
  ) => Effect.Effect<ExecuteResult, E>;

  /**
   * Execute code, intercepting the first elicitation as a pause point.
   * Use this when the host doesn't support inline elicitation.
   * Returns either a completed result or a paused execution that can be resumed.
   */
  readonly executeWithPause: (
    code: string,
    options?: { readonly trigger?: ExecutionTrigger },
  ) => Effect.Effect<ExecutionResult, E>;

  /**
   * Resume a paused execution. Returns a completed result, a new pause, or
   * null if the executionId was not found.
   */
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ExecutionResult | null, E>;

  /**
   * Get the dynamic tool description (workflow + namespaces).
   */
  readonly getDescription: Effect.Effect<string>;
};

export const createExecutionEngine = <
  E extends Cause.YieldableError = CodeExecutionError,
>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine<E> => {
  const { executor, codeExecutor } = config;
  const pausedExecutions = new Map<string, InternalPausedExecution<E>>();
  /** Tracks the running tool-call counter per active execution. Carries
   *  across pause/resume: the fiber keeps the same counter ref even
   *  though the Ref itself lives in the engine closure. */
  const toolCallCounters = new Map<string, Ref.Ref<number>>();

  const newExecutionId = (): ExecutionId =>
    ExecutionId.make(crypto.randomUUID());
  const newInteractionId = (): ExecutionInteractionId =>
    ExecutionInteractionId.make(crypto.randomUUID());
  const newToolCallId = (): ExecutionToolCallId =>
    ExecutionToolCallId.make(crypto.randomUUID());

  const ownerScopeId = () => executor.scopes[0]!.id;

  /** Wrap a SandboxToolInvoker so every `invoke` records a
   *  `execution_tool_call` row (running → completed|failed). Storage
   *  failures are swallowed so the tool call itself can never fail
   *  from a bookkeeping error. */
  const makeRecordingInvoker = (
    inner: SandboxToolInvoker,
    executionId: ExecutionId,
    counter: Ref.Ref<number>,
  ): SandboxToolInvoker => ({
    invoke: ({ path, args }) =>
      Effect.gen(function* () {
        const callId = newToolCallId();
        const startedAt = Date.now();
        yield* executor.executions
          .recordToolCall({
            id: callId,
            executionId,
            toolPath: path,
            argsJson: args === undefined ? undefined : safeStringify(args),
            startedAt,
          })
          .pipe(silent);
        yield* Ref.update(counter, (n) => n + 1);

        return yield* inner.invoke({ path, args }).pipe(
          Effect.tap((result) =>
            executor.executions
              .finishToolCall(callId, {
                status: "completed",
                resultJson: result === undefined ? null : safeStringify(result),
                completedAt: Date.now(),
                durationMs: Date.now() - startedAt,
              })
              .pipe(silent),
          ),
          Effect.tapError((err) =>
            executor.executions
              .finishToolCall(callId, {
                status: "failed",
                errorText: formatErrorMessage(err),
                completedAt: Date.now(),
                durationMs: Date.now() - startedAt,
              })
              .pipe(silent),
          ),
        );
      }),
  });

  /** Common post-run update. Runs once per execution on the Exit of
   *  the code-executor fiber — writes final status, result/error,
   *  logs, tool-call count, and completedAt. Ignores storage errors. */
  const persistTerminalState = (
    executionId: ExecutionId,
    exit:
      | { readonly _tag: "Success"; readonly result: ExecuteResult }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
    counter: Ref.Ref<number>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const toolCallCount = yield* Ref.get(counter);
      const completedAt = Date.now();

      if (exit._tag === "Success") {
        const { result } = exit;
        const hadError = Boolean(result.error);
        yield* executor.executions
          .update(executionId, {
            status: hadError ? "failed" : "completed",
            resultJson:
              result.result === undefined ? null : safeStringify(result.result),
            errorText: result.error ?? null,
            logsJson:
              result.logs && result.logs.length > 0
                ? safeStringify(result.logs)
                : null,
            completedAt,
            toolCallCount,
          })
          .pipe(silent);
        return;
      }

      yield* executor.executions
        .update(executionId, {
          status: "failed",
          errorText: formatCauseMessage(exit.cause),
          completedAt,
          toolCallCount,
        })
        .pipe(silent);
    });

  /**
   * Race a running fiber against a pause signal. Returns when either
   * the fiber completes or an elicitation handler fires (whichever
   * comes first). Re-used by both executeWithPause and resume.
   *
   * On fiber completion (success or failure) we finalize the
   * execution row here so persistence happens exactly once per run
   * regardless of whether the caller pauses first.
   */
  const awaitCompletionOrPause = (
    fiber: Fiber.Fiber<ExecuteResult, E>,
    pauseSignal: Deferred.Deferred<InternalPausedExecution<E>>,
    executionId: ExecutionId,
    counter: Ref.Ref<number>,
  ): Effect.Effect<ExecutionResult, E> =>
    Effect.race(
      Fiber.join(fiber).pipe(
        Effect.tap((result) =>
          persistTerminalState(executionId, { _tag: "Success", result }, counter),
        ),
        Effect.tapErrorCause((cause) =>
          persistTerminalState(executionId, { _tag: "Failure", cause }, counter),
        ),
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
  const startPausableExecution = Effect.fn("mcp.execute")(function* (
    code: string,
    options?: { readonly trigger?: ExecutionTrigger },
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "pausable",
      "mcp.execute.code_length": code.length,
    });

    const executionId = newExecutionId();
    const counter = yield* Ref.make(0);
    toolCallCounters.set(executionId, counter);

    yield* executor.executions
      .create({
        id: executionId,
        scopeId: ownerScopeId(),
        status: "running",
        code,
        startedAt: Date.now(),
        triggerKind: options?.trigger?.kind,
        triggerMetaJson: options?.trigger?.meta
          ? safeStringify(options.trigger.meta)
          : undefined,
      })
      .pipe(silent);

    // Ref holds the current pause signal. The elicitation handler reads
    // it each time it fires, so resume() can swap in a fresh Deferred
    // before unblocking the fiber.
    const pauseSignalRef = yield* Ref.make(yield* Deferred.make<InternalPausedExecution<E>>());

    // Will be set once the fiber is forked.
    let fiber: Fiber.Fiber<ExecuteResult, E>;

    const elicitationHandler: ElicitationHandler = (ctx) =>
      Effect.gen(function* () {
        const responseDeferred = yield* Deferred.make<typeof ElicitationResponse.Type>();
        const interactionId = newInteractionId();

        yield* executor.executions
          .update(executionId, { status: "waiting_for_interaction" })
          .pipe(silent);
        yield* executor.executions
          .recordInteraction({
            id: interactionId,
            executionId,
            status: "pending",
            kind: ctx.request._tag,
            purpose: ctx.request.message,
            payloadJson: safeStringify(serializeElicitationRequest(ctx)),
          })
          .pipe(silent);

        const paused: InternalPausedExecution<E> = {
          id: executionId,
          elicitationContext: ctx,
          response: responseDeferred,
          fiber: fiber!,
          pauseSignalRef,
          interactionId,
        };
        pausedExecutions.set(executionId, paused);

        const currentSignal = yield* Ref.get(pauseSignalRef);
        yield* Deferred.succeed(currentSignal, paused);

        // Suspend until resume() completes responseDeferred.
        return yield* Deferred.await(responseDeferred);
      });

    const fullInvoker = makeFullInvoker(executor, { onElicitation: elicitationHandler });
    const invoker = makeRecordingInvoker(fullInvoker, executionId, counter);
    fiber = yield* Effect.forkDaemon(
      codeExecutor.execute(code, invoker).pipe(Effect.withSpan("executor.code.exec")),
    );

    const initialSignal = yield* Ref.get(pauseSignalRef);
    return (yield* awaitCompletionOrPause(
      fiber,
      initialSignal,
      executionId,
      counter,
    )) as ExecutionResult;
  });

  /**
   * Resume a paused execution. Swaps in a fresh pause signal, completes
   * the response Deferred to unblock the fiber, then races completion
   * against the next pause.
   */
  const resumeExecution = Effect.fn("mcp.execute.resume")(function* (
    executionId: string,
    response: ResumeResponse,
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.resume.action": response.action,
    });

    const paused = pausedExecutions.get(executionId);
    if (!paused) return null;
    pausedExecutions.delete(executionId);

    const interactionStatus =
      response.action === "cancel" ? "cancelled" : "resolved";
    yield* executor.executions
      .resolveInteraction(paused.interactionId, {
        status: interactionStatus,
        responseJson: safeStringify({
          action: response.action,
          content: response.content ?? null,
        }),
      })
      .pipe(silent);
    yield* executor.executions
      .update(ExecutionId.make(executionId), { status: "running" })
      .pipe(silent);

    // Swap in a fresh pause signal BEFORE unblocking the fiber, so the
    // next elicitation handler call signals this new Deferred.
    const nextSignal = yield* Deferred.make<InternalPausedExecution<E>>();
    yield* Ref.set(paused.pauseSignalRef, nextSignal);

    yield* Deferred.succeed(paused.response, {
      action: response.action,
      content: response.content,
    });

    const counter =
      toolCallCounters.get(executionId) ?? (yield* Ref.make(0));
    return (yield* awaitCompletionOrPause(
      paused.fiber,
      nextSignal,
      ExecutionId.make(executionId),
      counter,
    )) as ExecutionResult;
  });

  /**
   * Inline-elicitation execute path. Wrapped so every call produces an
   * `mcp.execute` span with the inner `executor.code.exec` as a child.
   */
  const runInlineExecution = Effect.fn("mcp.execute")(function* (
    code: string,
    options: {
      readonly onElicitation: ElicitationHandler;
      readonly trigger?: ExecutionTrigger;
    },
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "inline",
      "mcp.execute.code_length": code.length,
    });
    const executionId = newExecutionId();
    const counter = yield* Ref.make(0);

    yield* executor.executions
      .create({
        id: executionId,
        scopeId: ownerScopeId(),
        status: "running",
        code,
        startedAt: Date.now(),
        triggerKind: options.trigger?.kind,
        triggerMetaJson: options.trigger?.meta
          ? safeStringify(options.trigger.meta)
          : undefined,
      })
      .pipe(silent);

    const recordingInteractionHandler: ElicitationHandler = (ctx) =>
      Effect.gen(function* () {
        const interactionId = newInteractionId();
        yield* executor.executions
          .recordInteraction({
            id: interactionId,
            executionId,
            status: "pending",
            kind: ctx.request._tag,
            purpose: ctx.request.message,
            payloadJson: safeStringify(serializeElicitationRequest(ctx)),
          })
          .pipe(silent);
        const response = yield* options.onElicitation(ctx);
        yield* executor.executions
          .resolveInteraction(interactionId, {
            status: response.action === "cancel" ? "cancelled" : "resolved",
            responseJson: safeStringify({
              action: response.action,
              content: response.content ?? null,
            }),
          })
          .pipe(silent);
        return response;
      });

    const fullInvoker = makeFullInvoker(executor, {
      onElicitation: recordingInteractionHandler,
    });
    const invoker = makeRecordingInvoker(fullInvoker, executionId, counter);

    return yield* codeExecutor
      .execute(code, invoker)
      .pipe(
        Effect.withSpan("executor.code.exec"),
        Effect.tap((result) =>
          persistTerminalState(executionId, { _tag: "Success", result }, counter),
        ),
        Effect.tapErrorCause((cause) =>
          persistTerminalState(executionId, { _tag: "Failure", cause }, counter),
        ),
      );
  });

  return {
    execute: runInlineExecution,
    executeWithPause: startPausableExecution,
    resume: resumeExecution,
    getDescription: buildExecuteDescription(executor),
  };
};
