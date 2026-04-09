import { Deferred, Effect, Fiber, Ref } from "effect";

import type {
  Executor,
  InvokeOptions,
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
} from "@executor/sdk";
import type { CodeExecutor, ExecuteResult, SandboxToolInvoker } from "@executor/codemode-core";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";

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

export type ExecutionEngineConfig = {
  readonly executor: Executor;
  readonly codeExecutor?: CodeExecutor;
};

export type ExecutionResult =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "paused"; readonly execution: PausedExecution };

export type PausedExecution = {
  readonly id: string;
  readonly elicitationContext: ElicitationContext;
  /** Deferred the caller completes with the user's response to resume the fiber. */
  readonly response: Deferred.Deferred<typeof ElicitationResponse.Type>;
  /** The fiber running the sandboxed code — stays alive across pause/resume cycles. */
  readonly fiber: Fiber.Fiber<ExecuteResult, unknown>;
  /** Ref to the current pause signal — swapped by resume() before unblocking. */
  readonly pauseSignalRef: Ref.Ref<Deferred.Deferred<PausedExecution>>;
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

export const formatExecuteResult = (result: ExecuteResult): {
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

  const logText =
    result.logs && result.logs.length > 0 ? result.logs.join("\n") : null;

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

export const formatPausedExecution = (paused: PausedExecution): {
  text: string;
  structured: Record<string, unknown>;
} => {
  const req = paused.elicitationContext.request;
  const lines: string[] = [`Execution paused: ${(req as any).message}`];

  if (req._tag === "UrlElicitation") {
    lines.push(`\nOpen this URL in a browser:\n${(req as any).url}`);
    lines.push("\nAfter the browser flow, resume with the executionId below:");
  } else {
    lines.push("\nResume with the executionId below and a response matching the requested schema:");
    const schema = (req as any).requestedSchema;
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
        message: (req as any).message,
        ...(req._tag === "UrlElicitation" ? { url: (req as any).url } : {}),
        ...(req._tag === "FormElicitation" ? { requestedSchema: (req as any).requestedSchema } : {}),
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Full invoker (base + discover + describe)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOptionalLimit = (
  value: unknown,
  toolName: string,
): number | ExecutionToolError => {
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

const makeFullInvoker = (
  executor: Executor,
  invokeOptions: InvokeOptions,
): SandboxToolInvoker => {
  const base = makeExecutorToolInvoker(executor, { invokeOptions });
  return {
    invoke: ({ path, args }) => {
      if (path === "search") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search expects an object: { query?: string; namespace?: string; limit?: number }",
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
              message: "tools.executor.sources.list expects an object: { query?: string; limit?: number }",
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

        const limit = readOptionalLimit(isRecord(args) ? args.limit : undefined, "tools.executor.sources.list");
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
      return base.invoke({ path, args });
    },
  };
};

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export type ExecutionEngine = {
  /**
   * Execute code with elicitation handled inline by the provided handler.
   * Use this when the host supports elicitation (e.g. MCP with elicitation capability).
   */
  readonly execute: (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) => Promise<ExecuteResult>;

  /**
   * Execute code, intercepting the first elicitation as a pause point.
   * Use this when the host doesn't support inline elicitation.
   * Returns either a completed result or a paused execution that can be resumed.
   */
  readonly executeWithPause: (code: string) => Promise<ExecutionResult>;

  /**
   * Resume a paused execution. Returns a completed result, a new pause, or
   * null if the executionId was not found.
   */
  readonly resume: (executionId: string, response: ResumeResponse) => Promise<ExecutionResult | null>;

  /**
   * Get the dynamic tool description (workflow + namespaces).
   */
  readonly getDescription: () => Promise<string>;
};

const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

export const createExecutionEngine = (config: ExecutionEngineConfig): ExecutionEngine => {
  const { executor } = config;
  const codeExecutor = config.codeExecutor ?? makeQuickJsExecutor();
  const pausedExecutions = new Map<string, PausedExecution>();
  let nextId = 0;

  /**
   * Race a running fiber against a pause signal. Returns when either
   * the fiber completes or an elicitation handler fires (whichever
   * comes first). Re-used by both executeWithPause and resume.
   */
  const awaitCompletionOrPause = (
    fiber: Fiber.Fiber<ExecuteResult, unknown>,
    pauseSignal: Deferred.Deferred<PausedExecution>,
  ): Effect.Effect<ExecutionResult> =>
    Effect.race(
      Fiber.join(fiber).pipe(
        Effect.orDie,
        Effect.map((result): ExecutionResult => ({ status: "completed", result })),
      ),
      Deferred.await(pauseSignal).pipe(
        Effect.map((paused): ExecutionResult => ({ status: "paused", execution: paused })),
      ),
    );

  /**
   * Start an execution in the pause/resume mode. Forks the sandbox
   * onto its own fiber and waits for either completion or the first
   * elicitation pause.
   */
  const startPausableExecution = (code: string): Effect.Effect<ExecutionResult> =>
    Effect.gen(function* () {
      // Ref holds the current pause signal. The elicitation handler reads
      // it each time it fires, so resume() can swap in a fresh Deferred
      // before unblocking the fiber.
      const pauseSignalRef = yield* Ref.make(
        yield* Deferred.make<PausedExecution>(),
      );

      // Will be set once the fiber is forked.
      let fiber: Fiber.Fiber<ExecuteResult, unknown>;

      const elicitationHandler: ElicitationHandler = (ctx) =>
        Effect.gen(function* () {
          const responseDeferred = yield* Deferred.make<typeof ElicitationResponse.Type>();
          const id = `exec_${++nextId}`;

          const paused: PausedExecution = {
            id,
            elicitationContext: ctx,
            response: responseDeferred,
            fiber: fiber!,
            pauseSignalRef,
          };
          pausedExecutions.set(id, paused);

          const currentSignal = yield* Ref.get(pauseSignalRef);
          yield* Deferred.succeed(currentSignal, paused);

          // Suspend until resume() completes responseDeferred.
          return yield* Deferred.await(responseDeferred);
        });

      const invoker = makeFullInvoker(executor, { onElicitation: elicitationHandler });
      fiber = yield* Effect.fork(codeExecutor.execute(code, invoker));

      const initialSignal = yield* Ref.get(pauseSignalRef);
      return yield* awaitCompletionOrPause(fiber, initialSignal);
    });

  /**
   * Resume a paused execution. Swaps in a fresh pause signal, completes
   * the response Deferred to unblock the fiber, then races completion
   * against the next pause.
   */
  const resumeExecution = (
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<ExecutionResult | null> =>
    Effect.gen(function* () {
      const paused = pausedExecutions.get(executionId);
      if (!paused) return null;
      pausedExecutions.delete(executionId);

      // Swap in a fresh pause signal BEFORE unblocking the fiber, so the
      // next elicitation handler call signals this new Deferred.
      const nextSignal = yield* Deferred.make<PausedExecution>();
      yield* Ref.set(paused.pauseSignalRef, nextSignal);

      yield* Deferred.succeed(paused.response, {
        action: response.action,
        content: response.content,
      });

      return yield* awaitCompletionOrPause(paused.fiber, nextSignal);
    });

  return {
    execute: async (code, options) => {
      const invoker = makeFullInvoker(executor, {
        onElicitation: options.onElicitation,
      });
      return runEffect(codeExecutor.execute(code, invoker));
    },

    executeWithPause: (code) => runEffect(startPausableExecution(code)),

    resume: (executionId, response) => runEffect(resumeExecution(executionId, response)),

    getDescription: () => runEffect(buildExecuteDescription(executor)),
  };
};
